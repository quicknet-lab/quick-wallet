// Builds real W5R1 signing messages with the same @ton/ton code the web app
// signs with, and writes them out as ton_tx_vectors.h for ton_tx_test.c: the
// device's parser has to agree with the library on the hash and on every
// field it shows. Run through ./run_tests.sh, which regenerates this first.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const { Address, BitString, Cell, Dictionary, beginCell, internal, toNano, SendMode, WalletContractV5R1, storeMessageRelaxed } =
  require('@ton/ton');

const pubkey = Buffer.alloc(32, 7);
const wallet = (networkGlobalId) =>
  WalletContractV5R1.create({
    walletId: { networkGlobalId, context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber: 0 } },
    publicKey: pubkey,
  });
const mainnet = wallet(-239);
const testnet = wallet(-3);

const addr = (byte, wc = 0) => Address.parseRaw(`${wc}:${byte.repeat(32)}`);
const APP_MODE = SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS;

/** The signing message, captured from the library's own signer callback. */
async function signingCell(w, messages, { sendMode = APP_MODE, extraActions = [] } = {}) {
  let captured;
  const actions = [
    ...messages.map((m) => ({ type: 'sendMsg', mode: sendMode, outMsg: internal(m) })),
    ...extraActions,
  ];
  await w.createRequest({
    seqno: 5,
    timeout: 1_900_000_000,
    authType: 'external',
    actions,
    signer: async (payload) => {
      captured = payload;
      return Buffer.alloc(64);
    },
  });
  return captured;
}

const jettonBody = (amount, to, comment) => {
  const b = beginCell()
    .storeUint(0x0f8a7ea5, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(to)
    .storeAddress(addr('dd'))
    .storeBit(0)
    .storeCoins(1n);
  if (comment) b.storeBit(1).storeRef(beginCell().storeUint(0, 32).storeStringTail(comment).endCell());
  else b.storeBit(0);
  return b.endCell();
};
const nftBody = (newOwner) =>
  beginCell()
    .storeUint(0x5fcc3d14, 32)
    .storeUint(0, 64)
    .storeAddress(newOwner)
    .storeAddress(addr('dd'))
    .storeBit(0)
    .storeCoins(1n)
    .storeBit(0)
    .endCell();

const longComment = 'x'.repeat(130);
const init = { code: beginCell().storeUint(1, 8).endCell(), data: beginCell().storeUint(2, 8).endCell() };

// [name, cell, expected] — expected.err names a TON_TX_ERR_* when refused.
const cases = [
  ['ton_transfer', await signingCell(mainnet, [{ to: addr('aa'), value: toNano('12.5'), bounce: false }]), {
    testnet: false,
    msgs: [{ kind: 'TRANSFER', ton: toNano('12.5'), dest: addr('aa'), bounce: false }],
  }],
  ['ton_comment_testnet', await signingCell(testnet, [{ to: addr('aa'), value: 1n, bounce: true, body: 'deposit 12345' }]), {
    testnet: true,
    msgs: [{ kind: 'TRANSFER', ton: 1n, dest: addr('aa'), bounce: true, comment: 'deposit 12345' }],
  }],
  ['ton_long_comment', await signingCell(mainnet, [{ to: addr('aa'), value: 1n, bounce: false, body: longComment }]), {
    testnet: false,
    msgs: [{ kind: 'TRANSFER', ton: 1n, dest: addr('aa'), bounce: false, comment: 'x'.repeat(117) + '...' }],
  }],
  ['ton_utf8_comment', await signingCell(mainnet, [{ to: addr('aa'), value: 1n, bounce: false, body: 'hi é' }]), {
    testnet: false,
    msgs: [{ kind: 'TRANSFER', ton: 1n, dest: addr('aa'), bounce: false, comment: 'hi ??' }],
  }],
  ['jetton_with_comment', await signingCell(mainnet, [{
    to: addr('bb'), value: toNano('0.05'), bounce: true, body: jettonBody(100_500_000n, addr('aa'), 'memo 42'),
  }]), {
    testnet: false,
    msgs: [{ kind: 'JETTON', ton: toNano('0.05'), dest: addr('bb'), bounce: true, tokenAmount: 100_500_000n, to: addr('aa'), comment: 'memo 42' }],
  }],
  ['nft', await signingCell(mainnet, [{ to: addr('bb'), value: toNano('0.05'), bounce: true, body: nftBody(addr('aa', -1)) }]), {
    testnet: false,
    msgs: [{ kind: 'NFT', ton: toNano('0.05'), dest: addr('bb'), bounce: true, to: addr('aa', -1) }],
  }],
  ['call_with_init_multi', await signingCell(mainnet, [
    { to: addr('aa'), value: toNano('10.25'), bounce: true, body: beginCell().storeUint(0xea06185d, 32).storeUint(9, 64).endCell() },
    { to: addr('cc'), value: toNano('0.3'), bounce: true, init, body: jettonBody(7n, addr('ee')) },
    { to: addr('ee'), value: 2n, bounce: false, body: beginCell().storeUint(3, 5).endCell() },
  ]), {
    testnet: false,
    msgs: [
      { kind: 'CALL', ton: toNano('10.25'), dest: addr('aa'), bounce: true, op: 0xea06185d },
      { kind: 'JETTON', ton: toNano('0.3'), dest: addr('cc'), bounce: true, deploys: true, tokenAmount: 7n, to: addr('ee') },
      { kind: 'CALL', ton: 2n, dest: addr('ee'), bounce: false },
    ],
  }],
  ['refuse_mode_128', await signingCell(mainnet, [{ to: addr('aa'), value: 1n, bounce: false }], {
    sendMode: SendMode.CARRY_ALL_REMAINING_BALANCE,
  }), { err: 'ACTION' }],
  ['refuse_add_extension', await signingCell(mainnet, [{ to: addr('aa'), value: 1n, bounce: false }], {
    extraActions: [{ type: 'addExtension', address: addr('ff') }],
  }), { err: 'ACTION' }],
  ['refuse_five_messages', await signingCell(mainnet, Array.from({ length: 5 }, () => ({ to: addr('aa'), value: 1n, bounce: false }))), {
    err: 'TOO_MANY',
  }],
];

// Hand-built refusals the library won't produce on its own.
const good = await signingCell(mainnet, [{ to: addr('aa'), value: 1n, bounce: false }]);
const rebuild = (fn) => {
  const s = good.beginParse();
  const b = beginCell();
  fn(s, b);
  return b.endCell();
};
cases.push(
  ['refuse_internal_auth', rebuild((s, b) => { s.loadUint(32); b.storeUint(0x73696e74, 32).storeSlice(s); }), { err: 'WALLET' }],
  ['refuse_other_subwallet', rebuild((s, b) => { b.storeUint(s.loadUint(32), 32); s.loadUint(32); b.storeUint(0x7fffff12, 32).storeSlice(s); }), { err: 'WALLET' }],
  ['refuse_set_code', beginCell().storeUint(0x7369676e, 32).storeUint(0x7fffff11, 32).storeUint(0, 64)
    .storeMaybeRef(beginCell().storeRef(beginCell().endCell()).storeUint(0xad4de08e, 32).storeRef(beginCell().endCell()).endCell())
    .storeBit(0).endCell(), { err: 'ACTION' }],
  ['refuse_extra_currency', beginCell().storeUint(0x7369676e, 32).storeUint(0x7fffff11, 32).storeUint(0, 64)
    .storeMaybeRef(beginCell().storeRef(beginCell().endCell()).storeUint(0x0ec3c86d, 32).storeUint(3, 8)
      .storeRef(beginCell().store(storeMessageRelaxed({
        info: { type: 'internal', ihrDisabled: true, bounce: false, bounced: false, dest: addr('aa'),
          value: { coins: 1n, other: Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.BigVarUint(5)).set(1, 5n) }, ihrFee: 0n, forwardFee: 0n, createdLt: 0n, createdAt: 0 },
        body: beginCell().endCell(),
      })).endCell()).endCell())
    .storeBit(0).endCell(), { err: 'MESSAGE' }],
);

// Token transfers a token contract would likely still carry out, but that
// don't parse strictly: refused, never shown as a plain contract call.
const addrVar = beginCell().storeUint(3, 2).storeBit(0).storeUint(256, 9).storeInt(0, 32).storeBuffer(Buffer.alloc(32, 0xdd)).endCell();
const transferMsg = (body) => signingCell(mainnet, [{ to: addr('bb'), value: toNano('0.05'), bounce: true, body }]);
cases.push(
  ['refuse_jetton_either_noref', await transferMsg(beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(5n)
    .storeAddress(addr('aa')).storeAddress(addr('dd')).storeBit(0).storeCoins(1n).storeBit(1).endCell()), { err: 'MESSAGE' }],
  ['refuse_jetton_resp_addrvar', await transferMsg(beginCell().storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(5n)
    .storeAddress(addr('aa')).storeSlice(addrVar.beginParse()).storeBit(0).storeCoins(1n).storeBit(0).endCell()), { err: 'MESSAGE' }],
  ['refuse_nft_resp_addrvar', await transferMsg(beginCell().storeUint(0x5fcc3d14, 32).storeUint(0, 64)
    .storeAddress(addr('aa')).storeSlice(addrVar.beginParse()).storeBit(0).storeCoins(1n).storeBit(0).endCell()), { err: 'MESSAGE' }],
);

const hex = (buf) => [...buf].map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',');
const amount16 = (v) => hex(Buffer.from((v ?? 0n).toString(16).padStart(32, '0'), 'hex'));
const cstr = (s) => JSON.stringify(s ?? '');
const addrInit = (a) => (a ? `{ ${a.workChain}, { ${hex(a.hash)} } }` : '{ 0, { 0 } }');

let out = '/* Generated by gen_vectors.mjs — do not edit. */\n#include "ton_tx.h"\n\n';
out += 'typedef struct { const char *kind; uint8_t ton[16]; ton_tx_addr_t dest; bool bounce; bool deploys;\n';
out += '  uint8_t token_amount[16]; ton_tx_addr_t to; const char *comment; bool has_op; uint32_t op; } expect_msg_t;\n';
out += 'typedef struct { const char *name; const uint8_t *boc; size_t boc_len; const char *err; uint8_t hash[32];\n';
out += '  bool testnet; size_t n_msgs; expect_msg_t msgs[4]; } vector_t;\n\n';
cases.forEach(([name], i) => {
  const boc = cases[i][1].toBoc({ idx: false, crc32: false });
  out += `static const uint8_t boc_${name}[] = { ${hex(boc)} };\n`;
});
out += '\nstatic const vector_t vectors[] = {\n';
for (const [name, cell, exp] of cases) {
  const msgs = (exp.msgs ?? []).map((m) =>
    `{ ${cstr(m.kind)}, { ${amount16(m.ton)} }, ${addrInit(m.dest)}, ${!!m.bounce}, ${!!m.deploys}, ` +
    `{ ${amount16(m.tokenAmount)} }, ${addrInit(m.to)}, ${m.comment === undefined ? 'NULL' : cstr(m.comment)}, ` +
    `${m.op !== undefined}, ${m.op ?? 0}u }`,
  );
  out += `  { ${cstr(name)}, boc_${name}, sizeof(boc_${name}), ${exp.err ? cstr(exp.err) : 'NULL'}, { ${hex(cell.hash())} },\n`;
  out += `    ${!!exp.testnet}, ${msgs.length}, { ${msgs.join(',\n      ')} } },\n`;
}
out += '};\n\n';

// Friendly-address rendering, checked against @ton/core's own.
const renders = [
  [addr('aa'), true, false], [addr('aa'), false, false], [addr('aa'), false, true], [addr('12', -1), true, true],
];
out += 'typedef struct { ton_tx_addr_t addr; bool bounceable; bool test_only; const char *expected; } address_vector_t;\n';
out += 'static const address_vector_t address_vectors[] = {\n';
for (const [a, bounceable, testOnly] of renders) {
  out += `  { ${addrInit(a)}, ${bounceable}, ${testOnly}, ${cstr(a.toString({ bounceable, testOnly }))} },\n`;
}
out += '};\n';

writeFileSync(fileURLToPath(new URL('./ton_tx_vectors.h', import.meta.url)), out);
console.log(`wrote ${cases.length} transaction vectors, ${renders.length} address vectors`);

// ton_proof (ton_proof.c): the wallet address from @ton/ton, and the hash to
// sign written out here straight from the TON Connect spec.
const { createHash } = await import('node:crypto');
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
function proofHash(w, domain, timestamp, payload) {
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(w.address.workChain);
  const dlen = Buffer.alloc(4);
  dlen.writeUInt32LE(Buffer.byteLength(domain));
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(timestamp));
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/'), wc, w.address.hash, dlen, Buffer.from(domain), ts, Buffer.from(payload),
  ]);
  return sha256(Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256(message));
}
const proofs = [
  [false, 'ton-connect.github.io', 1_758_620_000, 'e5b4ee4c8a2e1a9c'],
  [true, 'localhost:5173', 0, ''],
  [false, 'app.ston.fi', 2 ** 40 + 5, 'x'.repeat(256)],
];
let pout = '/* Generated by gen_vectors.mjs — do not edit. */\n#include <stdbool.h>\n#include <stdint.h>\n\n';
pout += `static const uint8_t proof_pubkey[32] = { ${hex(pubkey)} };\n`;
pout += `static const uint8_t proof_address_mainnet[32] = { ${hex(mainnet.address.hash)} };\n`;
pout += `static const uint8_t proof_address_testnet[32] = { ${hex(testnet.address.hash)} };\n\n`;
pout += 'typedef struct { bool testnet; const char *domain; uint64_t timestamp; const char *payload; uint8_t hash[32]; } proof_vector_t;\n';
pout += 'static const proof_vector_t proof_vectors[] = {\n';
for (const [isTestnet, domain, timestamp, payload] of proofs) {
  const h = proofHash(isTestnet ? testnet : mainnet, domain, timestamp, payload);
  pout += `  { ${isTestnet}, ${cstr(domain)}, ${timestamp}ull, ${cstr(payload)}, { ${hex(h)} } },\n`;
}
pout += '};\n';
writeFileSync(fileURLToPath(new URL('./ton_proof_vectors.h', import.meta.url)), pout);
console.log(`wrote ${proofs.length} proof vectors`);

// ton_jetton.c: USD₮ jetton wallet addresses. The library cell and data
// layout are pinned by a pair read off mainnet's USD₮ master with
// get_wallet_address on 2026-10-01; the rest are computed the same way.
const usdtMaster = Address.parse('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs');
const usdtCode = new Cell({ exotic: true, bits: new BitString(Buffer.from('028f452d7a4dfd74066b682365177259ed05734435be76b5fd4bd5d8af2b7c3d68', 'hex'), 0, 264) });
const usdtWallet = (owner) => {
  const data = beginCell().storeUint(0, 4).storeCoins(0).storeAddress(owner).storeAddress(usdtMaster).endCell();
  return beginCell().storeBit(0).storeBit(0).storeMaybeRef(usdtCode).storeMaybeRef(data).storeBit(0).endCell().hash();
};
const onChainOwner = Address.parseRaw(`0:${'ab'.repeat(32)}`);
if (usdtWallet(onChainOwner).toString('hex') !== '8e0769bd5f69541ae680ff6063308a775e04db68d73281053757bd5b19c4de94') {
  throw new Error('USD₮ wallet address no longer matches the on-chain one');
}
const jettonOwners = [onChainOwner, mainnet.address, Address.parseRaw(`0:${'00'.repeat(32)}`)];
let jout = '/* Generated by gen_vectors.mjs — do not edit. */\n#include <stdint.h>\n\n';
jout += 'typedef struct { uint8_t owner[32]; uint8_t wallet[32]; } jetton_vector_t;\n';
jout += 'static const jetton_vector_t jetton_vectors[] = {\n';
for (const owner of jettonOwners) jout += `  { { ${hex(owner.hash)} }, { ${hex(usdtWallet(owner))} } },\n`;
jout += '};\n';
writeFileSync(fileURLToPath(new URL('./ton_jetton_vectors.h', import.meta.url)), jout);
console.log(`wrote ${jettonOwners.length} jetton vectors`);

// wallet_seal.c: the same construction built from node:crypto alone, so the
// firmware's use of mbedtls is checked against an independent implementation.
// The "hardware" HMAC key is a fixed test value; wallet_seal_test.c uses the same.
const { pbkdf2Sync, createHmac, createCipheriv } = await import('node:crypto');
const sealHwKey = Buffer.alloc(32, 0x5a);
const seals = [
  ['123456', Buffer.alloc(16, 0x11), Buffer.alloc(12, 0x22), Buffer.from(Array.from({ length: 145 }, (_, i) => i))],
  ['a1b2c3d4e5', Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'), Buffer.alloc(12, 0xee), Buffer.alloc(145, 0)],
];
let sout = '/* Generated by gen_vectors.mjs — do not edit. */\n#include <stdint.h>\n\n';
sout += `static const uint8_t seal_hw_key[32] = { ${hex(sealHwKey)} };\n\n`;
sout += 'typedef struct { const char *pin; uint8_t salt[16]; uint8_t nonce[12]; uint8_t secret[145]; uint8_t blob[1 + 16 + 12 + 145 + 16]; } seal_vector_t;\n';
sout += 'static const seal_vector_t seal_vectors[] = {\n';
for (const [pin, salt, nonce, secret] of seals) {
  const kek = createHmac('sha256', sealHwKey).update(pbkdf2Sync(pin, salt, 10000, 32, 'sha256')).digest();
  const header = Buffer.concat([Buffer.from([1]), salt, nonce]);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  cipher.setAAD(header);
  const blob = Buffer.concat([header, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  sout += `  { ${cstr(pin)}, { ${hex(salt)} }, { ${hex(nonce)} }, { ${hex(secret)} }, { ${hex(blob)} } },\n`;
}
sout += '};\n';
writeFileSync(fileURLToPath(new URL('./wallet_seal_vectors.h', import.meta.url)), sout);
console.log(`wrote ${seals.length} seal vectors`);
