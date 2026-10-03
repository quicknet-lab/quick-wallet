import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/manrope';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './style.css';
import { Buffer } from 'buffer';
import { QuickWalletBle, OtaStatus, WalletStatus } from './ble';
import {
  TonWallet,
  fromNano,
  explorerAddressUrl,
  SendCancelledError,
  type ConfirmFee,
  type Network,
  type PreparedTransfer,
} from './wallet';
import { SEND_ALL_RESERVE_NANO, formatOwnAddress } from './validation';
import {
  KNOWN_MAINNET_JETTONS,
  TOKEN_TRANSFER_GAS,
  findKnownMainnetJetton,
  formatUnits,
  parseUnits,
  shortAmount,
  type JettonHolding,
  type NftItem,
} from './tokens';
import {
  downloadBinary,
  downloadImage,
  fetchLatestRelease,
  manifestConfigured,
  updateAvailable,
  type FirmwareRelease,
  type FlashPlan,
} from './firmware';
import { flashDevice, usbFlashingSupported } from './flash';
import { Address, Cell, beginCell, storeStateInit } from '@ton/core';
import { signVerify } from '@ton/crypto';
import { SessionCrypto, type AppRequest, type ConnectItemReply, type RpcMethod } from '@tonconnect/protocol';
import {
  DEVICE_INFO,
  ERROR,
  TonConnectError,
  decodeTokenTransfer,
  errorResponse,
  fetchManifest,
  isNewRequest,
  listen,
  loadApps,
  markRequestAnswered,
  parseConnectLink,
  parseSendTransaction,
  saveApps,
  sendEvent,
  sendResponse,
  tonProofHash,
  type ConnectLink,
  type ConnectedApp,
} from './tonconnect';
import type { HistoryItem } from './history';
import { GRAM_ASSET, USDT_ASSET, fetchUsdPrices, formatUsdt, totalInUsdt } from './price';
import { addressQrSvg } from './qr';
import { checkQuoteMatchesRequest, isSwapQuote, swapAllAmount, type Quote, type SwapAsset } from './swap';
import type { QuoteOfType } from '@ston-fi/omniston-sdk';
import type { Omniston } from './omniston';

// Diagnostic net: a bug in an event handler that isn't inside a try/catch
// (or a rejected promise nobody awaited) would otherwise fail completely
// silently from the user's point of view — button click, nothing visible,
// nothing logged. This at least puts it in the console.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[unhandled]', event.reason);
});

const app = document.querySelector<HTMLDivElement>('#app')!;

// Inside someone else's page, the wallet refuses to start at all: a framing
// site could lay its own buttons over this one (clickjacking). The host's
// frame-ancestors header (public/_headers) stops that in the browser; this
// holds on a host that can't send it, or if the header is ever lost.
if (window.top !== window.self) {
  const link = document.createElement('a');
  link.href = location.href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Open Quick Wallet in its own tab';
  app.replaceChildren('Quick Wallet does not run inside another page. ', link);
  throw new Error('Quick Wallet refuses to run in a frame');
}

const ICON_PATHS = {
  send: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  receive: '<path d="M17 7 7 17"/><path d="M17 17H7V7"/>',
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  more: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
  shield: '<path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  bluetooth: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  list: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  wallet: '<path d="M19 7V5a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
} as const;

const ic = (name: keyof typeof ICON_PATHS) =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

const LOGO = `<svg class="logo" viewBox="0 0 100 100" aria-hidden="true">
  <path fill="currentColor" d="M26 18h40l-32 64h-8a10 10 0 0 1-10-10v-44a10 10 0 0 1 10-10z"/>
  <path class="logo-accent" d="M74 18a10 10 0 0 1 10 10v44a10 10 0 0 1-10 10h-30l32-64z"/>
</svg>`;

app.innerHTML = `
  <div class="toasts">
    <div id="status" class="status" hidden></div>
    <div id="result" class="result" hidden></div>
  </div>

  <main class="shell">
    <header class="appbar">
      <span class="brand">${LOGO}<span>QUICK WALLET</span></span>
      <span class="appbar-chips">
        <span class="chip chip-live"><span class="dot"></span><span class="chip-text">Connected</span></span>
        <span class="chip chip-net" id="net-chip"></span>
      </span>
    </header>

    <div id="unsupported-banner" class="notice notice-warn" hidden>
      ${ic('alert')}
      <span>Web Bluetooth unavailable in this browser. Use desktop Chrome/Edge or
      Android Chrome — Safari on iOS/macOS is not supported.</span>
    </div>

    <section id="connect-section" class="screen">
      <div class="card">
        <label class="input" for="network-select">
          <span class="input-label">Network</span>
          <span class="input-control">
            <select id="network-select">
              <option value="mainnet" selected>mainnet</option>
              <option value="testnet">testnet</option>
            </select>
            ${ic('down')}
          </span>
        </label>
        <button id="connect-btn" class="btn btn-primary btn-block">${ic('bluetooth')}Connect to device</button>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="tile">${ic('plug')}</span>
          <h2>New device</h2>
        </div>
        <p class="note">A wallet fresh out of its box has no firmware on it yet. Plug it into
        this computer with a USB cable and install the current release — there is
        nothing to download or install on your side, and no drivers to hunt for:
        the browser talks to the device directly.</p>
        <button id="flash-btn" class="btn btn-ghost btn-block">Install firmware over USB</button>
      </div>
    </section>

    <section id="create-wallet-section" class="screen" hidden>
      <div class="hero">
        <h1>No wallet yet</h1>
        <p>This device has no wallet yet. Creating one generates a new key
        pair on the device itself — it never leaves the chip.</p>
      </div>
      <button id="create-wallet-btn" class="btn btn-primary btn-block">${ic('plus')}Create new wallet</button>
    </section>

    <section id="seed-prompt-section" class="screen" hidden>
      <div class="hero">
        <h1>Back up your recovery phrase</h1>
        <p>Your wallet is backed by a 24-word phrase generated on the device.
        It's the only way to recover this wallet if it's lost. View it now and
        write it down somewhere safe — the device will then ask you for three of
        the words, and you can't continue until you get them right.</p>
      </div>
      <button id="seed-prompt-view-btn" class="btn btn-primary btn-block">View backup phrase now</button>
      <button id="seed-prompt-continue-btn" class="btn btn-ghost btn-block" hidden>Continue to the wallet</button>
    </section>

    <section id="pin-gate-section" class="screen" hidden>
      <div id="pin-set-block">
        <div class="hero">
          <h1>Set a PIN</h1>
          <p>It protects signing and every other sensitive
          action, and the wallet key created next is encrypted under it. 6 to 10
          characters. It can't be recovered — without it, only the 24-word
          phrase gets you to the funds.</p>
        </div>
        <form id="pin-set-form" class="card">
          <label class="input" for="pin-set-input">
            <span class="input-label">PIN</span>
            <span class="input-control"><input id="pin-set-input" type="password" inputmode="numeric" placeholder="6-10 characters" required /></span>
          </label>
          <button type="submit" id="pin-set-btn" class="btn btn-primary btn-block">Set PIN</button>
        </form>
      </div>

      <div id="pin-unlock-block" hidden>
        <div class="hero">
          <h1>Enter your PIN</h1>
          <p>Enter the device PIN to unlock signing for this connection.</p>
        </div>
        <form id="pin-unlock-form" class="card">
          <label class="input" for="pin-unlock-input">
            <span class="input-label">PIN</span>
            <span class="input-control"><input id="pin-unlock-input" type="password" inputmode="numeric" placeholder="6-10 characters" required /></span>
          </label>
          <button type="submit" id="pin-verify-btn" class="btn btn-primary btn-block">Unlock</button>
        </form>
      </div>

    </section>

    <section id="wallet-section" class="wallet" hidden>
      <div id="fw-banner" class="notice notice-warn" hidden>
        ${ic('alert')}
        <span id="fw-banner-text"></span>
        <button type="button" id="fw-banner-btn" class="btn btn-small">Install it</button>
      </div>

      <div id="home-head">
        <div class="card balance-card">
          <span class="balance-label">Balance</span>
          <div class="balance" id="wallet-balance">…</div>
          <div class="balance-sub" id="wallet-balance-sub" hidden></div>
          <div class="actions">
            <button type="button" class="action action-wide" data-open="sheet-send"><span class="tile">${ic('send')}</span>Send</button>
            <button type="button" class="action action-wide" data-open="sheet-receive"><span class="tile">${ic('receive')}</span>Receive</button>
            <button type="button" class="action" id="refresh-btn" aria-label="Refresh"><span class="tile">${ic('refresh')}</span></button>
          </div>
        </div>
        <div class="chips">
          <button type="button" class="chip-btn is-active" aria-pressed="true" data-view="wallet">Tokens</button>
          <button type="button" class="chip-btn" aria-pressed="false" data-view="nft">NFTs</button>
        </div>
      </div>

      <div id="view-wallet">
        <div id="assets-list" class="list"></div>
        <button type="button" class="add-token" data-open="sheet-add-token"><span class="tile">${ic('plus')}</span>Add token</button>
        <button type="button" id="assets-scam-btn" class="btn btn-ghost btn-block" hidden></button>
        <p class="footnote">Token and NFT holdings are found through toncenter's
        index, so it sees which address is being asked about. It cannot change
        what the device signs — the recipient and the amount are always the ones
        typed here. Anything not on the built-in list of known tokens is marked
        unverified: on TON, a name alone proves nothing.</p>
      </div>

      <div id="view-nft" hidden>
        <div id="nft-empty" class="empty" hidden></div>
        <div id="nft-list" class="nft-grid"></div>
        <button type="button" id="nft-refresh-btn" class="btn btn-ghost btn-block">Refresh</button>
      </div>

      <div id="view-swap" hidden>
        <div class="view-head">
          <h1 class="view-title">Swap</h1>
          <button type="button" class="icon-btn" data-open="sheet-swap-settings" aria-label="Swap settings">${ic('sliders')}</button>
        </div>
        <div id="swap-testnet-note" class="notice notice-warn" hidden>
          ${ic('alert')}
          <span>STON.fi's swap protocol only runs on TON mainnet. Reconnect on mainnet to use this tab.</span>
        </div>
        <div id="swap-body" hidden>
          <form id="swap-quote-form">
            <div class="swap-card">
              <div class="leg">
                <div class="leg-head">
                  <span class="leg-label">From</span>
                  <span id="swap-from-balance" class="leg-balance" hidden></span>
                </div>
                <button type="button" id="swap-from-btn" class="token-pill" aria-label="From asset"></button>
                <div class="leg-amount">
                  <input id="swap-from-amount" class="amount-input" type="text" inputmode="decimal" placeholder="0" aria-label="Amount" autocomplete="off" required />
                  <!-- TEMPORARILY hidden (0.0.x): the ALL fit to the quote's gas is not yet checked on the board. --><button type="button" id="swap-max-btn" class="chip-btn chip-small" hidden>ALL</button>
                </div>
              </div>
              <button type="button" id="swap-flip-btn" class="flip" title="Swap direction" aria-label="Swap direction">${ic('swap')}</button>
              <div class="leg">
                <div class="leg-head">
                  <span class="leg-label">To</span>
                  <span id="swap-to-balance" class="leg-balance" hidden></span>
                </div>
                <button type="button" id="swap-to-btn" class="token-pill" aria-label="To asset"></button>
                <div class="leg-amount">
                  <output id="swap-to-amount" class="amount-out" aria-live="polite">0</output>
                </div>
              </div>
            </div>
            <div id="swap-details" class="fields" hidden>
              <div class="field"><span>Rate</span><span id="swap-rate"></span></div>
              <div class="field"><span>Min. received</span><span id="swap-min"></span></div>
              <div class="field"><span>Price impact</span><span id="swap-impact"></span></div>
              <div class="field"><span>Max. slippage</span><span id="swap-slippage-shown"></span></div>
            </div>
            <div id="swap-live" class="swap-live" hidden><span class="dot"></span><span id="swap-live-text"></span></div>
            <button type="submit" id="swap-quote-btn" class="btn btn-primary btn-block" disabled>Swap</button>
          </form>
          <p class="footnote">Quoted live by STON.fi's Omniston protocol and
          refreshed automatically. Nothing is sent until you press Swap, review
          the quote and confirm on the device.</p>
        </div>
      </div>

      <div id="view-history" hidden>
        <h1 class="view-title">History</h1>
        <button type="button" id="history-refresh-btn" class="btn btn-ghost btn-block">Refresh</button>
        <div id="history-list" class="list"></div>
        <div id="history-empty" class="empty" hidden>No transactions yet.</div>
        <button type="button" id="history-more-btn" class="btn btn-ghost btn-block" hidden>Show more</button>
        <p class="footnote">Read from toncenter's index, which sees which address is
        being asked about. Tokens the index flags as scams are left out.</p>
      </div>

      <div id="view-dapps" hidden>
        <h1 class="view-title">Apps</h1>
        <form id="tc-link-form" class="card">
          <p class="note">On the site, open "Connect wallet", pick any wallet
          and use "Copy link" under the QR code, then paste it here. Requests
          from connected sites appear on this tab while the device is connected;
          nothing is signed without the button on the device.</p>
          <label class="input" for="tc-link-input">
            <span class="input-label">Connection link</span>
            <span class="input-control"><input id="tc-link-input" type="text" placeholder="tc://?v=2&amp;id=…" autocomplete="off" required /></span>
          </label>
          <button type="submit" id="tc-link-btn" class="btn btn-primary btn-block">${ic('link')}Connect</button>
        </form>
        <h2 class="section-title">Connected sites</h2>
        <div id="tc-apps" class="list"></div>
        <div id="tc-apps-empty" class="empty">No sites connected.</div>
      </div>

      <div id="view-more" hidden>
        <h1 class="view-title">More</h1>
        <div class="card menu">
          <button type="button" class="menu-row" data-open="sheet-firmware">
            <span class="tile">${ic('cpu')}</span>
            <span class="menu-text"><b>Firmware</b><small>Version and updates</small></span>
            ${ic('chevron')}
          </button>
          <button type="button" class="menu-row" data-open="sheet-pin">
            <span class="tile">${ic('key')}</span>
            <span class="menu-text"><b>Change PIN</b><small>Protects signing and the key</small></span>
            ${ic('chevron')}
          </button>
          <button type="button" class="menu-row" id="show-seed-btn">
            <span class="tile">${ic('shield')}</span>
            <span class="menu-text"><b>Recovery phrase</b><small>Shown on the device screen only</small></span>
            ${ic('chevron')}
          </button>
          <div class="menu-row menu-info">
            <span class="tile">${ic('list')}</span>
            <span class="menu-text"><b>Transactions sent</b></span>
            <span class="menu-value" id="wallet-seqno">…</span>
          </div>
        </div>

        <div class="card menu">
          <button type="button" class="menu-row" id="disconnect-btn">
            <span class="tile">${ic('power')}</span>
            <span class="menu-text"><b>Disconnect</b><small>Lock signing and leave</small></span>
            ${ic('chevron')}
          </button>
        </div>

        <div class="card menu menu-danger">
          <button type="button" class="menu-row" id="wipe-btn">
            <span class="tile">${ic('trash')}</span>
            <span class="menu-text"><b>Erase wallet</b><small>Factory reset of the device</small></span>
            ${ic('chevron')}
          </button>
        </div>
        <p class="footnote footnote-danger">Erasing the wallet destroys the key and the PIN on
        this device. Only the 24-word phrase can recover the funds, and only into
        another wallet — this device cannot import a phrase back.</p>
      </div>

      <nav class="tabbar" aria-label="Sections">
        <button type="button" class="tab is-active" aria-current="page" data-view="wallet" data-also="nft">${ic('home')}<span>Home</span></button>
        <button type="button" class="tab" data-view="swap">${ic('swap')}<span>Swap</span></button>
        <button type="button" class="tab" data-view="history">${ic('history')}<span>History</span></button>
        <button type="button" class="tab" data-view="dapps">${ic('apps')}<span>Apps</span></button>
        <button type="button" class="tab" data-view="more">${ic('more')}<span>More</span></button>
      </nav>
    </section>
  </main>

  <div id="sheet-send" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-send-title">
      <div class="sheet-head">
        <h2 id="sheet-send-title">Send</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <form id="send-form" class="form">
        <label class="input" for="asset-select">
          <span class="input-label">Asset</span>
          <span class="input-control"><select id="asset-select"></select>${ic('down')}</span>
        </label>
        <label class="input" for="to-input">
          <span class="input-label">To</span>
          <span class="input-control"><input id="to-input" type="text" placeholder="EQ…" autocomplete="off" spellcheck="false" required /></span>
        </label>
        <label class="input" for="amount-input">
          <span class="input-label">Amount</span>
          <span class="input-control">
            <input id="amount-input" type="text" inputmode="decimal" placeholder="0.05" autocomplete="off" required />
            <span class="unit" id="send-unit">GRAM</span>
            <button type="button" id="send-max-btn" class="chip-btn chip-small">ALL</button>
          </span>
        </label>
        <label class="input" for="comment-input">
          <span class="input-label">Comment</span>
          <span class="input-control"><input id="comment-input" type="text" placeholder="Optional" autocomplete="off" /></span>
        </label>
        <div id="send-hint" class="hint" hidden></div>
        <button type="submit" id="send-btn" class="btn btn-primary btn-block">Sign &amp; Send</button>
        <p class="footnote">The device shows the amount and the full address. Its button turns the pages; hold it for a second on the last page to sign.</p>
      </form>
    </div>
  </div>

  <div id="sheet-receive" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-receive-title">
      <div class="sheet-head">
        <h2 id="sheet-receive-title">Receive</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <div class="form">
        <div id="wallet-address-qr" class="qr-box" role="img" aria-label="QR code of the wallet address"></div>
        <div class="address-box"><code id="wallet-address"></code></div>
        <button type="button" id="copy-address-btn" class="btn btn-primary btn-block">${ic('copy')}<span>Copy address</span></button>
        <button type="button" id="verify-address-btn" class="btn btn-ghost btn-block">Check on device</button>
        <p class="footnote">Before you hand this address out, check it on the device: it computes
        the address from its own key. A fake page or a fake device can show another one here.</p>
        <p class="footnote">Send only GRAM and TON tokens to this address.</p>
      </div>
    </div>
  </div>

  <div id="sheet-add-token" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-add-token-title">
      <div class="sheet-head">
        <h2 id="sheet-add-token-title">Add token</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <form id="add-token-form" class="form">
        <p class="note">Paste the token's jetton master contract address. It will
        appear in your list and can be picked in Swap. Anyone can deploy a token
        with any name, so added tokens are marked unverified.</p>
        <label class="input" for="add-token-input">
          <span class="input-label">Contract</span>
          <span class="input-control"><input id="add-token-input" type="text" placeholder="Jetton master address" autocomplete="off" spellcheck="false" required /></span>
        </label>
        <button type="submit" id="add-token-btn" class="btn btn-primary btn-block">Add token</button>
      </form>
    </div>
  </div>

  <div id="sheet-swap-settings" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-swap-settings-title">
      <div class="sheet-head">
        <h2 id="sheet-swap-settings-title">Swap settings</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <div class="form">
        <label class="input" for="swap-slippage-input">
          <span class="input-label">Max. slippage</span>
          <span class="input-control">
            <input id="swap-slippage-input" type="text" inputmode="decimal" autocomplete="off" />
            <span class="unit">%</span>
          </span>
        </label>
        <div class="chips chips-tight">
          <button type="button" class="chip-btn" data-slippage="0.5">0.5%</button>
          <button type="button" class="chip-btn" data-slippage="1">1%</button>
          <button type="button" class="chip-btn" data-slippage="2">2%</button>
        </div>
        <label class="switch-row" for="swap-auto-slippage">
          <span class="menu-text"><b>Auto slippage</b><small>Omniston picks the tolerance for each quote. When off, the max slippage above is used.</small></span>
          <input id="swap-auto-slippage" class="switch" type="checkbox" role="switch" />
        </label>
        <p class="footnote">Slippage is how far the price may move between this quote and the
        moment the swap lands. If it moves more, the swap is cancelled and the funds come back.</p>
      </div>
    </div>
  </div>

  <div id="sheet-token-pick" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-token-pick-title">
      <div class="sheet-head">
        <h2 id="sheet-token-pick-title">Select token</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <div class="form">
        <div id="token-pick-list" class="list"></div>
        <p id="token-pick-note" class="footnote"></p>
      </div>
    </div>
  </div>

  <div id="sheet-firmware" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-firmware-title">
      <div class="sheet-head">
        <h2 id="sheet-firmware-title">Firmware</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <div class="form">
        <div class="fields">
          <div class="field"><span>On device</span><span id="fw-version">…</span></div>
          <div class="field"><span>Available</span><span id="fw-latest">…</span></div>
        </div>
        <button type="button" id="fw-check-btn" class="btn btn-ghost btn-block">Check for updates</button>
        <button type="button" id="fw-update-btn" class="btn btn-primary btn-block" hidden>Install update</button>
      </div>
    </div>
  </div>

  <div id="sheet-pin" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-pin-title">
      <div class="sheet-head">
        <h2 id="sheet-pin-title">Change PIN</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <form id="pin-change-form" class="form">
        <label class="input" for="pin-change-input">
          <span class="input-label">New PIN</span>
          <span class="input-control"><input id="pin-change-input" type="password" inputmode="numeric" placeholder="6-10 characters" required /></span>
        </label>
        <button type="submit" id="pin-change-btn" class="btn btn-primary btn-block">Change PIN</button>
      </form>
    </div>
  </div>

  <div id="nft-transfer" class="modal-overlay" data-sheet hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="nft-transfer-title">
      <div class="sheet-head">
        <h2 id="nft-transfer-title">Transfer NFT</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">${ic('x')}</button>
      </div>
      <form id="nft-form" class="form">
        <div class="fields">
          <div class="field"><span>Item</span><span id="nft-transfer-name"></span></div>
        </div>
        <label class="input" for="nft-to-input">
          <span class="input-label">To</span>
          <span class="input-control"><input id="nft-to-input" type="text" placeholder="EQ…" autocomplete="off" spellcheck="false" required /></span>
        </label>
        <label class="input" for="nft-comment-input">
          <span class="input-label">Comment</span>
          <span class="input-control"><input id="nft-comment-input" type="text" placeholder="Optional" autocomplete="off" /></span>
        </label>
        <button type="submit" id="nft-send-btn" class="btn btn-primary btn-block">Sign &amp; Transfer</button>
        <button type="button" id="nft-cancel-btn" class="btn btn-ghost btn-block">Cancel</button>
      </form>
    </div>
  </div>

  <div id="flash-modal-overlay" class="modal-overlay" hidden>
    <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="flash-modal-title">
      <div class="sheet-head">
        <h2 id="flash-modal-title">Install firmware</h2>
      </div>
      <div class="form">
        <div class="fields">
          <div class="field"><span>Version</span><code id="flash-modal-version"></code></div>
          <div class="field"><span>Chip</span><code id="flash-modal-chip"></code></div>
          <div class="field"><span>Download</span><code id="flash-modal-size"></code></div>
        </div>
        <p id="flash-modal-dev-note" class="danger-note">This is development firmware: <b>Secure Boot and
        Flash Encryption are not switched on yet</b>. The device stays
        re-flashable over USB, and anyone who gets hold of it with a USB cable
        can read the wallet key and the 24-word phrase straight out of its
        flash. Don't keep more on it than you can afford to lose.</p>
        <p id="flash-modal-secure-note" class="danger-note">This firmware <b>locks the device
        for good</b> the first time it starts: Secure Boot and Flash Encryption
        are burned into the chip and cannot be undone. From then on the device
        runs only firmware signed by this project, its flash cannot be read over
        USB, and it can no longer be reinstalled from this page — updates come
        over Bluetooth, from the app. <b>The first start takes up to a minute
        while the flash is encrypted: keep the cable plugged in until the
        screen comes up.</b></p>
        <p class="danger-note">Everything currently on the device is erased,
        including any wallet key already on it. Do this on a new device — or on
        one whose 24-word phrase you have written down.</p>
        <p class="note">You'll be asked to pick the device's USB port next. Leave it plugged
        in until the install finishes.</p>
        <button type="button" id="flash-modal-confirm" class="btn btn-danger btn-block">I understand — install it</button>
        <button type="button" id="flash-modal-cancel" class="btn btn-ghost btn-block">Cancel</button>
      </div>
    </div>
  </div>

  <div id="confirm-modal-overlay" class="modal-overlay" hidden>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <div class="sheet-head">
        <h2 id="confirm-modal-title"></h2>
      </div>
      <div class="form">
        <p id="confirm-modal-message" class="note" hidden></p>
        <div id="confirm-modal-fields" class="fields"></div>
        <button type="button" id="confirm-modal-confirm" class="btn btn-primary btn-block"></button>
        <button type="button" id="confirm-modal-cancel" class="btn btn-ghost btn-block"></button>
      </div>
    </div>
  </div>
`;

if (!navigator.bluetooth) {
  document.querySelector<HTMLDivElement>('#unsupported-banner')!.hidden = false;
}

const connectBtn = document.querySelector<HTMLButtonElement>('#connect-btn')!;
const createWalletSection = document.querySelector<HTMLElement>('#create-wallet-section')!;
const createWalletBtn = document.querySelector<HTMLButtonElement>('#create-wallet-btn')!;
const seedPromptSection = document.querySelector<HTMLElement>('#seed-prompt-section')!;
const seedPromptViewBtn = document.querySelector<HTMLButtonElement>('#seed-prompt-view-btn')!;
const seedPromptContinueBtn = document.querySelector<HTMLButtonElement>('#seed-prompt-continue-btn')!;
const refreshBtn = document.querySelector<HTMLButtonElement>('#refresh-btn')!;
const showSeedBtn = document.querySelector<HTMLButtonElement>('#show-seed-btn')!;
const networkSelect = document.querySelector<HTMLSelectElement>('#network-select')!;
const pinGateSection = document.querySelector<HTMLElement>('#pin-gate-section')!;
const pinSetBlock = document.querySelector<HTMLElement>('#pin-set-block')!;
const pinUnlockBlock = document.querySelector<HTMLElement>('#pin-unlock-block')!;
const walletSection = document.querySelector<HTMLElement>('#wallet-section')!;
const addressEl = document.querySelector<HTMLElement>('#wallet-address')!;
const addressQrEl = document.querySelector<HTMLElement>('#wallet-address-qr')!;
const balanceEl = document.querySelector<HTMLElement>('#wallet-balance')!;
const balanceSubEl = document.querySelector<HTMLElement>('#wallet-balance-sub')!;
const seqnoEl = document.querySelector<HTMLElement>('#wallet-seqno')!;
const sendForm = document.querySelector<HTMLFormElement>('#send-form')!;
const sendBtn = document.querySelector<HTMLButtonElement>('#send-btn')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const resultEl = document.querySelector<HTMLDivElement>('#result')!;
const pinSetForm = document.querySelector<HTMLFormElement>('#pin-set-form')!;
const pinSetInput = document.querySelector<HTMLInputElement>('#pin-set-input')!;
const pinSetBtn = document.querySelector<HTMLButtonElement>('#pin-set-btn')!;
const pinUnlockForm = document.querySelector<HTMLFormElement>('#pin-unlock-form')!;
const pinUnlockInput = document.querySelector<HTMLInputElement>('#pin-unlock-input')!;
const pinVerifyBtn = document.querySelector<HTMLButtonElement>('#pin-verify-btn')!;
const connectSection = document.querySelector<HTMLElement>('#connect-section')!;
const disconnectBtn = document.querySelector<HTMLButtonElement>('#disconnect-btn')!;
const fwVersionEl = document.querySelector<HTMLElement>('#fw-version')!;
const fwLatestEl = document.querySelector<HTMLElement>('#fw-latest')!;
const fwCheckBtn = document.querySelector<HTMLButtonElement>('#fw-check-btn')!;
const fwUpdateBtn = document.querySelector<HTMLButtonElement>('#fw-update-btn')!;
const fwBanner = document.querySelector<HTMLDivElement>('#fw-banner')!;
const fwBannerText = document.querySelector<HTMLElement>('#fw-banner-text')!;
const fwBannerBtn = document.querySelector<HTMLButtonElement>('#fw-banner-btn')!;
const flashBtn = document.querySelector<HTMLButtonElement>('#flash-btn')!;
const flashModalOverlay = document.querySelector<HTMLDivElement>('#flash-modal-overlay')!;
const flashModalVersion = document.querySelector<HTMLElement>('#flash-modal-version')!;
const flashModalChip = document.querySelector<HTMLElement>('#flash-modal-chip')!;
const flashModalDevNote = document.querySelector<HTMLElement>('#flash-modal-dev-note')!;
const flashModalSecureNote = document.querySelector<HTMLElement>('#flash-modal-secure-note')!;
const flashModalSize = document.querySelector<HTMLElement>('#flash-modal-size')!;
const flashModalConfirmBtn = document.querySelector<HTMLButtonElement>('#flash-modal-confirm')!;
const flashModalCancelBtn = document.querySelector<HTMLButtonElement>('#flash-modal-cancel')!;
const pinChangeForm = document.querySelector<HTMLFormElement>('#pin-change-form')!;
const pinChangeInput = document.querySelector<HTMLInputElement>('#pin-change-input')!;
const pinChangeBtn = document.querySelector<HTMLButtonElement>('#pin-change-btn')!;
const wipeBtn = document.querySelector<HTMLButtonElement>('#wipe-btn')!;
const viewWallet = document.querySelector<HTMLElement>('#view-wallet')!;
const viewNft = document.querySelector<HTMLElement>('#view-nft')!;
const viewMore = document.querySelector<HTMLElement>('#view-more')!;
const homeHead = document.querySelector<HTMLElement>('#home-head')!;
const netChip = document.querySelector<HTMLElement>('#net-chip')!;
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'));
const assetsListEl = document.querySelector<HTMLDivElement>('#assets-list')!;
const assetsScamBtn = document.querySelector<HTMLButtonElement>('#assets-scam-btn')!;
const assetSelect = document.querySelector<HTMLSelectElement>('#asset-select')!;
const sendUnitEl = document.querySelector<HTMLElement>('#send-unit')!;
const sendHintEl = document.querySelector<HTMLDivElement>('#send-hint')!;
const amountInput = document.querySelector<HTMLInputElement>('#amount-input')!;
const nftListEl = document.querySelector<HTMLDivElement>('#nft-list')!;
const nftEmptyEl = document.querySelector<HTMLDivElement>('#nft-empty')!;
const nftRefreshBtn = document.querySelector<HTMLButtonElement>('#nft-refresh-btn')!;
const nftTransferEl = document.querySelector<HTMLElement>('#nft-transfer')!;
const nftTransferNameEl = document.querySelector<HTMLElement>('#nft-transfer-name')!;
const nftForm = document.querySelector<HTMLFormElement>('#nft-form')!;
const nftToInput = document.querySelector<HTMLInputElement>('#nft-to-input')!;
const nftCommentInput = document.querySelector<HTMLInputElement>('#nft-comment-input')!;
const nftSendBtn = document.querySelector<HTMLButtonElement>('#nft-send-btn')!;
const nftCancelBtn = document.querySelector<HTMLButtonElement>('#nft-cancel-btn')!;
const viewSwap = document.querySelector<HTMLElement>('#view-swap')!;
const swapTestnetNote = document.querySelector<HTMLDivElement>('#swap-testnet-note')!;
const swapBody = document.querySelector<HTMLDivElement>('#swap-body')!;
const swapQuoteForm = document.querySelector<HTMLFormElement>('#swap-quote-form')!;
const swapFromBtn = document.querySelector<HTMLButtonElement>('#swap-from-btn')!;
const swapFromAmountInput = document.querySelector<HTMLInputElement>('#swap-from-amount')!;
const swapMaxBtn = document.querySelector<HTMLButtonElement>('#swap-max-btn')!;
const swapFlipBtn = document.querySelector<HTMLButtonElement>('#swap-flip-btn')!;
const swapToBtn = document.querySelector<HTMLButtonElement>('#swap-to-btn')!;
const swapFromBalanceEl = document.querySelector<HTMLElement>('#swap-from-balance')!;
const swapToBalanceEl = document.querySelector<HTMLElement>('#swap-to-balance')!;
const addTokenForm = document.querySelector<HTMLFormElement>('#add-token-form')!;
const addTokenInput = document.querySelector<HTMLInputElement>('#add-token-input')!;
const addTokenBtn = document.querySelector<HTMLButtonElement>('#add-token-btn')!;
const tokenPickSheet = document.querySelector<HTMLElement>('#sheet-token-pick')!;
const tokenPickList = document.querySelector<HTMLDivElement>('#token-pick-list')!;
const tokenPickNote = document.querySelector<HTMLElement>('#token-pick-note')!;
const swapQuoteBtn = document.querySelector<HTMLButtonElement>('#swap-quote-btn')!;
const swapToAmountEl = document.querySelector<HTMLOutputElement>('#swap-to-amount')!;
const swapDetailsEl = document.querySelector<HTMLElement>('#swap-details')!;
const swapRateEl = document.querySelector<HTMLElement>('#swap-rate')!;
const swapMinEl = document.querySelector<HTMLElement>('#swap-min')!;
const swapImpactEl = document.querySelector<HTMLElement>('#swap-impact')!;
const swapSlippageShownEl = document.querySelector<HTMLElement>('#swap-slippage-shown')!;
const swapLiveEl = document.querySelector<HTMLElement>('#swap-live')!;
const swapLiveText = document.querySelector<HTMLElement>('#swap-live-text')!;
const swapSlippageInput = document.querySelector<HTMLInputElement>('#swap-slippage-input')!;
const swapAutoSlippageInput = document.querySelector<HTMLInputElement>('#swap-auto-slippage')!;
const viewHistory = document.querySelector<HTMLElement>('#view-history')!;
const historyListEl = document.querySelector<HTMLDivElement>('#history-list')!;
const historyEmptyEl = document.querySelector<HTMLDivElement>('#history-empty')!;
const historyMoreBtn = document.querySelector<HTMLButtonElement>('#history-more-btn')!;
const historyRefreshBtn = document.querySelector<HTMLButtonElement>('#history-refresh-btn')!;
const viewDapps = document.querySelector<HTMLElement>('#view-dapps')!;
const tcLinkForm = document.querySelector<HTMLFormElement>('#tc-link-form')!;
const tcLinkInput = document.querySelector<HTMLInputElement>('#tc-link-input')!;
const tcAppsEl = document.querySelector<HTMLDivElement>('#tc-apps')!;
const tcAppsEmpty = document.querySelector<HTMLDivElement>('#tc-apps-empty')!;

const ble = new QuickWalletBle();
let wallet: TonWallet | null = null;
let pendingRelease: FirmwareRelease | null = null;
/** Images downloaded for a USB install, waiting on the warning modal. */
let pendingFlash: { plan: FlashPlan; images: ArrayBuffer[]; version: string } | null = null;
/** Jettons this wallet holds, keyed for the send form by master address. */
let jettons: JettonHolding[] = [];
/** Whether the tokens the indexer flagged as scams are currently listed. */
let showFlagged = false;
let nfts: NftItem[] = [];
let nftsLoaded = false;
let selectedNft: NftItem | null = null;
/** Created lazily on first visit to the SWAP tab — STON.fi's Omniston relay
 * is a live WebSocket connection, no reason to open it before it's used. */
let omniston: Omniston | null = null;
type QuoteOfSwap = QuoteOfType<'swap'>;
type SwapQuoteContext = {
  quote: Quote;
  from: SwapAsset;
  to: SwapAsset;
  fromSymbol: string;
  toSymbol: string;
  fromDecimals: number;
  toDecimals: number;
  amountUnits: bigint;
  /** Whether Omniston's recommended slippage applies, or the user's cap. */
  autoSlippage: boolean;
};

/** Formats a quote leg for display, in whole units. */
function formatSwapAmount(units: string | bigint, decimals: number, symbol: string): string {
  return `${shortAmount(formatUnits(BigInt(units), decimals))} ${symbol}`;
}
/** Last TON balance read, so the ASSETS table can be re-rendered without
 * spending another RPC call just to redraw the first row. */
let lastTonBalance = 0n;
/** USD prices (mainnet) of GRAM, USD₮ and the held tokens that STON.fi lists as regular assets, keyed by master address. */
let usdPrices = new Map<string, number>();
/** Set once the first price lookup of the session has answered. */
let pricesLoaded = false;
/** Set while a disconnect is expected as part of an operation (factory
 * reset, firmware update), so it isn't reported to the user as a fault. */
let expectingReboot = false;

let activeCountdown: ReturnType<typeof setInterval> | null = null;

function stopCountdown() {
  if (activeCountdown !== null) {
    clearInterval(activeCountdown);
    activeCountdown = null;
  }
}

/** How long a toast stays up. Errors get longer: they are the ones worth reading. */
const TOAST_MS = { info: 2000, success: 2000, error: 6000 } as const;
/** A long message needs more than the base time to be read: 60 ms a character, at least the base. */
const toastDuration = (text: string, kind: keyof typeof TOAST_MS) => Math.max(TOAST_MS[kind], text.length * 60);
/** Progress and "press the button" prompts stay until the next message
 * replaces them (with a long cap so nothing hangs there forever): they are
 * what the user is waiting on, not news to glance at. */
const ONGOING_TOAST_MS = 120_000;
const isOngoing = (text: string) => /…$|%$|^Press /.test(text);
let statusHideTimer: ReturnType<typeof setTimeout> | null = null;
let resultHideTimer: ReturnType<typeof setTimeout> | null = null;

function setStatusText(text: string, kind: 'info' | 'error' | 'success' = 'info') {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
  // Every update restarts the timer, so a ticking countdown stays up and
  // disappears only after its last line.
  if (statusHideTimer !== null) clearTimeout(statusHideTimer);
  statusHideTimer = setTimeout(() => (statusEl.hidden = true), isOngoing(text) ? ONGOING_TOAST_MS : toastDuration(text, kind));
}

/** Any status update kills a running countdown — guarantees the countdown
 * can never keep ticking past whatever outcome (signed/rejected/error/etc.)
 * gets shown next, regardless of whether the caller remembered to stop it. */
function showStatus(text: string, kind: 'info' | 'error' | 'success' = 'info') {
  stopCountdown();
  setStatusText(text, kind);
}

/**
 * Shows a live countdown while waiting for the device's physical confirm
 * button, mirroring the firmware's own 30s window (CONFIRM_TIMEOUT_US in
 * gatt_svc.c) — this is purely a UI convenience; the device enforces the
 * real deadline independently and drops the pending action on its own if
 * the button isn't pressed in time. Any subsequent showStatus() call
 * (success, error, or a new countdown) automatically stops this one.
 */
function startConfirmCountdown(label: string, seconds = 30) {
  stopCountdown();
  let remaining = seconds;
  setStatusText(`${label} (${remaining}s)…`);
  activeCountdown = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      stopCountdown();
      return;
    }
    setStatusText(`${label} (${remaining}s)…`);
  }, 1000);
}

/**
 * Drops everything the unlocked session put on screen: the device has
 * locked (or lost) that session, so anything still shown from it would be a
 * lie, and every button in it would fail.
 */
function clearWalletSession() {
  wallet = null;
  lastTonBalance = 0n;
  stopSwapWatch();
  pendingRelease = null;
  jettons = [];
  customJettons = [];
  usdPrices = new Map();
  pricesLoaded = false;
  history = [];
  historyLoaded = false;
  historyHasMore = false;
  historyOffset = 0;
  historyListEl.replaceChildren();
  swapFromValue = 'ton';
  swapToValue = '';
  tokenMetaCache.clear();
  nfts = [];
  nftsLoaded = false;
  showFlagged = false;
  selectedNft = null;
  nftTransferEl.hidden = true;
  assetsListEl.replaceChildren();
  nftListEl.replaceChildren();
  // Omniston.close() exists at runtime but is missing from the SDK's type
  // declarations (v0.8.9) — closing the transport directly is the typed path.
  omniston?.transport.close();
  omniston = null;
  stopTonConnect();
  closeSheets();
  switchView('wallet');
  walletSection.hidden = true;
  resultEl.hidden = true;
  fwUpdateBtn.hidden = true;
  fwBanner.hidden = true;
  networkSelect.disabled = false;
}

/**
 * Back to the pre-connection screen. Called both on an explicit disconnect
 * and when the link drops on its own: the device clears its unlocked PIN
 * session on every disconnect.
 */
function resetToDisconnected(message: string, kind: 'info' | 'error' | 'success' = 'info') {
  clearWalletSession();
  pinGateSection.hidden = true;
  seedPromptSection.hidden = true;
  createWalletSection.hidden = true;
  connectSection.hidden = false;
  showStatus(message, kind);
}

// Still connected, just locked: a correct PIN goes straight back to where
// an unlocked session leads (handlePinResult).
ble.onSessionLocked = () => {
  if (!connectSection.hidden || !pinGateSection.hidden) return;
  clearWalletSession();
  pinUnlockInput.value = '';
  enterPinGate('Locked after 5 minutes without use. Enter your PIN to continue.', 'unlock');
};

ble.onDisconnected = () => {
  if (expectingReboot) {
    expectingReboot = false;
    resetToDisconnected(
      'The device rebooted, as expected. Give it a few seconds, then connect again.',
      'success',
    );
    return;
  }
  resetToDisconnected('The device disconnected. Connect again to continue.', 'error');
};

type View = 'wallet' | 'nft' | 'swap' | 'history' | 'dapps' | 'more';

function switchView(view: View) {
  viewWallet.hidden = view !== 'wallet';
  viewNft.hidden = view !== 'nft';
  viewSwap.hidden = view !== 'swap';
  viewHistory.hidden = view !== 'history';
  viewDapps.hidden = view !== 'dapps';
  viewMore.hidden = view !== 'more';
  homeHead.hidden = view !== 'wallet' && view !== 'nft';
  for (const tab of tabButtons) {
    const active = tab.dataset.view === view || tab.dataset.also === view;
    tab.classList.toggle('is-active', active);
    if (tab.classList.contains('tab')) {
      if (active) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    } else if (tab.classList.contains('chip-btn')) {
      tab.setAttribute('aria-pressed', String(active));
    }
  }
  window.scrollTo({ top: 0 });
}

for (const tab of tabButtons) {
  tab.addEventListener('click', () => {
    const view: View = (['nft', 'swap', 'history', 'dapps', 'more'] as const).find((v) => v === tab.dataset.view) ?? 'wallet';
    switchView(view);
    // Loaded on first sight rather than on connect: it's a second indexer
    // call, and plenty of wallets never open this tab at all.
    if (view === 'nft' && !nftsLoaded) {
      loadNfts().catch((err) => showStatus(`Loading NFTs failed: ${(err as Error).message}`, 'error'));
    }
    if (view === 'history' && !historyLoaded) {
      loadHistory(true).catch((err) => showStatus(`Loading history failed: ${(err as Error).message}`, 'error'));
    }
    if (view !== 'swap') stopSwapWatch();
    if (view === 'swap') {
      openSwapTab().catch((err) => showStatus(`Loading the swap client failed: ${(err as Error).message}`, 'error'));
    }
  });
}

// -------------------------------------------------------------- sheets

/** Bottom sheets (Send, Receive, Firmware, PIN, NFT transfer). Opened by any
 * `data-open="<id>"` element, closed by `data-close`, a click on the dimmed
 * backdrop, or Escape. The confirm and install modals are not sheets: they
 * wait on a decision and manage their own dismissal. */
let sheetOpener: HTMLElement | null = null;

function closeSheets() {
  const wasOpen = Array.from(document.querySelectorAll<HTMLElement>('[data-sheet]')).some((sheet) => !sheet.hidden);
  for (const sheet of document.querySelectorAll<HTMLElement>('[data-sheet]')) sheet.hidden = true;
  // Hand focus back to whatever opened the sheet, if it is still on screen.
  if (wasOpen && sheetOpener?.isConnected && sheetOpener.offsetParent !== null) sheetOpener.focus();
  sheetOpener = null;
}

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const opener = target.closest<HTMLElement>('[data-open]');
  if (opener) {
    closeSheets();
    sheetOpener = opener;
    const sheet = document.getElementById(opener.dataset.open!);
    if (sheet) {
      sheet.hidden = false;
      sheet.querySelector<HTMLElement>('input, select')?.focus({ preventScroll: true });
    }
    return;
  }
  if (target.closest('[data-close]') || (target.hasAttribute('data-sheet') && target === e.target)) {
    closeSheets();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !confirmModalOverlay.hidden || !flashModalOverlay.hidden) return;
  closeSheets();
});

document.querySelector('.toasts')!.addEventListener('click', (e) => {
  const toast = (e.target as HTMLElement).closest<HTMLElement>('.status, .result');
  if (toast) toast.hidden = true;
});

const copyAddressBtn = document.querySelector<HTMLButtonElement>('#copy-address-btn')!;
copyAddressBtn.addEventListener('click', () => {
  const label = copyAddressBtn.querySelector('span')!;
  navigator.clipboard
    .writeText(addressEl.textContent ?? '')
    .then(() => {
      label.textContent = 'Copied';
      setTimeout(() => (label.textContent = 'Copy address'), 1600);
    })
    .catch(() => showStatus('Could not copy — select the address and copy it by hand.', 'error'));
});

const verifyAddressBtn = document.querySelector<HTMLButtonElement>('#verify-address-btn')!;
verifyAddressBtn.addEventListener('click', async () => {
  if (!wallet) return;
  verifyAddressBtn.disabled = true;
  try {
    await ble.showAddress(wallet.network === 'testnet', (s) => {
      if (s === WalletStatus.AddressShowing) {
        showStatus('Compare every character on the device screen with the address here, then press the device button.', 'info');
      }
    });
    showStatus('Done — if anything differed, do not use the address shown here.', 'success');
  } catch (err) {
    showStatus(`Showing the address on the device failed: ${(err as Error).message}`, 'error');
  } finally {
    verifyAddressBtn.disabled = false;
  }
});

// ------------------------------------------------------------- assets

/** The TON coin mark, inline so it needs no request. */
const TON_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 56 56'><circle cx='28' cy='28' r='28' fill='#0098EA'/>" +
      "<path d='M37.6 15.6H18.4c-3.5 0-5.7 3.8-4 6.9l11.8 20.5c.8 1.3 2.7 1.3 3.5 0L41.6 22.5c1.7-3.1-.5-6.9-4-6.9zM26.5 36.9l-2.6-5-6.2-11c-.4-.7.1-1.6.9-1.6h7.9v17.6zm11.8-16.1-6.2 11-2.6 5.1V19.2h7.9c.8 0 1.3.9.9 1.6z' fill='white'/></svg>",
  );

/** A token's round logo, or its first letters when it has none. */
function tokenIcon(image: string | null, symbol: string): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'asset-icon';
  if (image) {
    const img = document.createElement('img');
    img.src = image;
    img.alt = '';
    img.loading = 'lazy';
    icon.appendChild(img);
  } else {
    icon.textContent = symbol.slice(0, 2).toUpperCase();
  }
  return icon;
}

/** One line of the ASSETS table. All token-supplied text goes in as text. */
function assetRow(opts: {
  image: string | null;
  symbol: string;
  name: string;
  badge: { text: string; kind: 'ok' | 'warn' } | null;
  amount: string;
  /** The price of one unit, under the amount; left out when there is no trusted price. */
  usd?: string;
  /** A tappable row, for the token picker. */
  button?: boolean;
}): HTMLElement {
  const row = document.createElement(opts.button ? 'button' : 'div');
  row.className = 'asset';
  if (opts.button) (row as HTMLButtonElement).type = 'button';

  const icon = tokenIcon(opts.image, opts.symbol);

  const symbol = document.createElement('span');
  symbol.className = 'asset-symbol';
  symbol.textContent = opts.symbol;

  const top = document.createElement('span');
  top.className = 'asset-top';
  top.appendChild(symbol);
  if (opts.badge) {
    const badge = document.createElement('span');
    badge.className = `badge badge-${opts.badge.kind}`;
    badge.textContent = opts.badge.text;
    top.appendChild(badge);
  }

  const name = document.createElement('span');
  name.className = 'asset-name';
  name.textContent = opts.name;

  const text = document.createElement('span');
  text.className = 'asset-text';
  text.append(top, name);

  const amount = document.createElement('span');
  amount.className = 'asset-amount';
  amount.textContent = shortAmount(opts.amount);

  if (opts.usd === undefined) {
    row.append(icon, text, amount);
    return row;
  }
  const usd = document.createElement('span');
  usd.className = 'asset-usd';
  usd.textContent = opts.usd;
  const amounts = document.createElement('span');
  amounts.className = 'asset-amounts';
  amounts.append(amount, usd);
  row.append(icon, text, amounts);
  return row;
}

/** The USD price of one unit of `asset`, as "$1.52" or "$0.001537". On
 * mainnet every row gets this line, so prices arriving never shift the list:
 * "$0.00" until the first lookup answers, then "—" for a token without a
 * trusted price (or `null`, one that must not get a figure). Testnet has no
 * prices at all and no line. */
function usdPrice(asset: string | null): string | undefined {
  if (wallet?.network !== 'mainnet') return undefined;
  if (!pricesLoaded) return `$${formatUsdt(0)}`;
  const price = asset === null ? undefined : usdPrices.get(asset);
  if (price === undefined) return '—';
  return price >= 1 ? `$${formatUsdt(price)}` : `$${shortAmount(price.toFixed(8))}`;
}

function visibleJettons(): JettonHolding[] {
  return showFlagged ? jettons : jettons.filter((j) => !j.isScam);
}

function renderAssets(tonBalance: bigint) {
  const rows: HTMLElement[] = [
    assetRow({
      image: TON_ICON,
      symbol: 'GRAM',
      name: 'Gram',
      badge: { text: 'native', kind: 'ok' },
      amount: fromNano(tonBalance),
      usd: usdPrice(GRAM_ASSET),
    }),
  ];
  for (const jetton of visibleJettons()) {
    rows.push(
      assetRow({
        image: jetton.image,
        symbol: jetton.symbol,
        name: jetton.name,
        badge: jetton.isScam
          ? { text: 'flagged', kind: 'warn' }
          : // Two sources disagree about where this token's decimal point
            // goes, so the balance below may be off by a factor of ten or
            // more and sending it is refused — say so rather than show a
            // reassuring "verified".
            jetton.decimalsDisputed
            ? { text: 'bad scale', kind: 'warn' }
            : jetton.verified
              ? { text: 'verified', kind: 'ok' }
              : { text: 'unverified', kind: 'warn' },
        amount: formatUnits(jetton.balance, jetton.decimals),
        // A flagged token's pool price can be anything, and a disputed scale
        // makes the amount itself unreliable — neither gets a dollar figure.
        usd: usdPrice(jetton.isScam || jetton.decimalsDisputed ? null : jetton.master.toString({ bounceable: true })),
      }),
    );
  }
  // The registry's tokens and the ones added by address that this wallet
  // doesn't hold yet.
  for (const t of notHeldRows()) {
    rows.push(
      assetRow({
        image: t.image,
        symbol: t.symbol,
        name: t.name,
        badge: t.verified ? { text: 'verified', kind: 'ok' } : { text: 'unverified', kind: 'warn' },
        amount: '0',
        usd: usdPrice(t.master === Address.parse(USDT_ASSET).toRawString() ? USDT_ASSET : null),
      }),
    );
  }
  assetsListEl.replaceChildren(...rows);

  const flagged = jettons.filter((j) => j.isScam).length;
  assetsScamBtn.hidden = flagged === 0;
  assetsScamBtn.textContent = showFlagged
    ? `Hide ${flagged} flagged token${flagged === 1 ? '' : 's'}`
    : `Show ${flagged} flagged token${flagged === 1 ? '' : 's'}`;
}

assetsScamBtn.addEventListener('click', () => {
  showFlagged = !showFlagged;
  renderAssets(lastTonBalance);
  populateAssetSelect();
});

/** TON plus every currently visible held jetton, as `<option>`s keyed by
 * raw master address (or "ton"), for the SEND asset picker. */
function heldAssetOptions(): HTMLOptionElement[] {
  const options: HTMLOptionElement[] = [new Option('GRAM', 'ton')];
  for (const jetton of visibleJettons()) {
    options.push(new Option(`${jetton.symbol} — ${jetton.name}`, jetton.master.toRawString()));
  }
  return options;
}

/**
 * Rebuilds the SEND asset picker, keeping the current choice if that token
 * is still in the list — a background refresh shouldn't silently move the
 * selection to something else while a transfer is being typed.
 */
function populateAssetSelect() {
  const previous = assetSelect.value;
  const options = heldAssetOptions();
  assetSelect.replaceChildren(...options);
  assetSelect.value = options.some((o) => o.value === previous) ? previous : 'ton';
  onAssetChange();
  renderSwapLegs();
}

function selectedJetton(): JettonHolding | null {
  return jettons.find((j) => j.master.toRawString() === assetSelect.value) ?? null;
}

function onAssetChange() {
  const jetton = selectedJetton();
  sendUnitEl.textContent = jetton ? jetton.symbol : 'GRAM';
  if (jetton) {
    sendHintEl.hidden = false;
    sendHintEl.textContent =
      `Available: ${shortAmount(formatUnits(jetton.balance, jetton.decimals))} ${jetton.symbol}. ` +
      'Sending a token also spends about 0.05 GRAM of gas; whatever is left over comes back.';
  } else {
    sendHintEl.hidden = true;
  }
}

assetSelect.addEventListener('change', onAssetChange);

// ALL: a token in full (its gas is paid in TON separately), TON minus the
// fee reserve so the transfer can still pay its own network fee.
document.querySelector<HTMLButtonElement>('#send-max-btn')!.addEventListener('click', () => {
  const jetton = selectedJetton();
  if (jetton) {
    amountInput.value = formatUnits(jetton.balance, jetton.decimals);
    return;
  }
  const units = lastTonBalance > SEND_ALL_RESERVE_NANO ? lastTonBalance - SEND_ALL_RESERVE_NANO : 0n;
  amountInput.value = fromNano(units);
});

// ---------------------------------------------------------------- swap

/** A jetton the user added by pasting its master address, kept alongside
 * the pinned KNOWN_MAINNET_JETTONS registry so it shows a real symbol
 * instead of the generic "jetton" fallback and reappears across reloads.
 * Unlike KNOWN_MAINNET_JETTONS these are unverified — anyone can deploy a
 * jetton claiming any symbol. */
type CustomJetton = { symbol: string; name: string; decimals: number; master: string; image?: string | null };

/** Mainnet keeps the original key, so tokens added before testnet got its own list stay put. */
const customJettonsKey = (network: Network) => (network === 'mainnet' ? 'cw-custom-jettons' : `cw-custom-jettons-${network}`);

/** Only entries of the right shape with a parseable master address survive —
 * one broken record would otherwise throw out of every Address.parse over
 * the list and break the swap tab until storage is cleared by hand. */
function isCustomJetton(entry: unknown): entry is CustomJetton {
  if (typeof entry !== 'object' || entry === null) return false;
  const { symbol, name, decimals, master, image } = entry as Record<string, unknown>;
  // A logo is only ever loaded through toncenter's proxy — see pickImage() in tokens.ts.
  if (image != null && !(typeof image === 'string' && image.startsWith('https://proxy.toncenter.com/'))) return false;
  if (typeof symbol !== 'string' || typeof name !== 'string' || typeof master !== 'string') return false;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return false;
  try {
    Address.parse(master);
  } catch {
    return false;
  }
  return true;
}

function loadCustomJettons(network: Network): CustomJetton[] {
  try {
    const raw = localStorage.getItem(customJettonsKey(network));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isCustomJetton) : [];
  } catch {
    return [];
  }
}

function saveCustomJettons() {
  if (!wallet) return;
  try {
    localStorage.setItem(customJettonsKey(wallet.network), JSON.stringify(customJettons));
  } catch {
    // Private browsing / quota — the list just won't survive a reload.
  }
}

let customJettons: CustomJetton[] = [];

/** What the swap and token pickers show for one token. `value` is "ton" or
 * the raw master address. */
type TokenOption = {
  value: string;
  symbol: string;
  name: string;
  image: string | null;
  badge: { text: string; kind: 'ok' | 'warn' } | null;
  /** Balance held, for tokens the wallet owns. */
  amount: string;
};

/** Logos and names of tokens the wallet doesn't hold, looked up once per
 * session (a failed lookup is remembered too, so it isn't retried on every
 * redraw). */
const tokenMetaCache = new Map<string, { name: string; image: string | null }>();
let tokenMetaPending = false;

/** The registry and the added tokens that the wallet doesn't hold — the ones
 * whose logo has to come from a lookup. */
function unheldTokens(): { master: string; symbol: string; name: string; verified: boolean }[] {
  const heldKeys = new Set(jettons.map((j) => j.master.toRawString()));
  const out: { master: string; symbol: string; name: string; verified: boolean }[] = [];
  const seen = new Set<string>();
  const add = (master: string, symbol: string, name: string, verified: boolean) => {
    const key = Address.parse(master).toRawString();
    if (heldKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ master: key, symbol, name, verified });
  };
  if (wallet?.network === 'mainnet') {
    for (const k of KNOWN_MAINNET_JETTONS) add(k.master, k.symbol, k.name, true);
  }
  for (const c of customJettons) add(c.master, c.symbol, c.name, false);
  return out;
}

/** Registry and added tokens that this wallet doesn't hold, as rows for the home list. */
function notHeldRows(): { master: string; symbol: string; name: string; image: string | null; verified: boolean }[] {
  const customKeys = new Map(customJettons.map((c) => [Address.parse(c.master).toRawString(), c]));
  return unheldTokens().map((t) => ({
    master: t.master,
    symbol: t.symbol,
    name: t.name,
    verified: t.verified,
    image: customKeys.get(t.master)?.image ?? tokenMetaCache.get(t.master)?.image ?? null,
  }));
}

/** Fetches the missing logos and names one at a time (the indexer is rate
 * limited), redrawing whatever shows them as each arrives. */
async function loadTokenMeta() {
  if (!wallet || tokenMetaPending) return;
  const current = wallet;
  tokenMetaPending = true;
  try {
    for (const t of unheldTokens()) {
      if (tokenMetaCache.has(t.master) || customJettons.some((c) => c.image && Address.parse(c.master).toRawString() === t.master)) continue;
      let meta: { name: string; image: string | null } = { name: t.name, image: null };
      try {
        const info = await current.getJettonMaster(Address.parseRaw(t.master));
        if (info) meta = { name: info.name, image: info.image };
      } catch {
        // Offline or rate limited: the row keeps its letters, and the lookup
        // is tried again next time instead of being remembered as "no logo".
        continue;
      }
      if (wallet !== current) return;
      tokenMetaCache.set(t.master, meta);
      renderSwapLegs();
      renderAssets(lastTonBalance);
      if (!tokenPickSheet.hidden) renderTokenPick();
    }
  } finally {
    tokenMetaPending = false;
  }
}

/** TON, what the wallet holds, the registry and added tokens. */
function swapCatalog(): TokenOption[] {
  const options: TokenOption[] = [
    { value: 'ton', symbol: 'GRAM', name: 'Gram', image: TON_ICON, badge: { text: 'native', kind: 'ok' }, amount: fromNano(lastTonBalance) },
  ];
  for (const j of visibleJettons()) {
    options.push({
      value: j.master.toRawString(),
      symbol: j.symbol,
      name: j.name,
      image: j.image,
      badge: j.decimalsDisputed
        ? { text: 'bad scale', kind: 'warn' }
        : j.verified
          ? { text: 'verified', kind: 'ok' }
          : { text: 'unverified', kind: 'warn' },
      amount: formatUnits(j.balance, j.decimals),
    });
  }
  for (const t of unheldTokens()) {
    const custom = customJettons.find((c) => Address.parse(c.master).toRawString() === t.master);
    const meta = tokenMetaCache.get(t.master);
    options.push({
      value: t.master,
      symbol: t.symbol,
      name: meta?.name ?? t.name,
      image: custom?.image ?? meta?.image ?? null,
      badge: t.verified ? { text: 'verified', kind: 'ok' } : { text: 'unverified', kind: 'warn' },
      amount: '',
    });
  }
  return options;
}

/** The asset the swap can start from: TON or a held token. */
function swapHeldCatalog(): TokenOption[] {
  const held = new Set(['ton', ...visibleJettons().map((j) => j.master.toRawString())]);
  return swapCatalog().filter((o) => held.has(o.value));
}

/** "ton" or a raw master address; the destination is "" until picked. */
let swapFromValue = 'ton';
let swapToValue = '';

function selectedSwapFromJetton(): JettonHolding | null {
  return jettons.find((j) => j.master.toRawString() === swapFromValue) ?? null;
}

function renderTokenPill(btn: HTMLButtonElement, option: TokenOption | undefined) {
  btn.replaceChildren(tokenIcon(option?.image ?? null, option?.symbol ?? '?'));
  const label = document.createElement('span');
  label.className = 'token-pill-label';
  label.textContent = option ? option.symbol : 'Select token';
  btn.append(label);
  btn.insertAdjacentHTML('beforeend', ic('down'));
  btn.classList.toggle('is-empty', !option);
}

/** The wallet's balance of a leg's token, beside its label. */
function renderLegBalance(el: HTMLElement, option: TokenOption | undefined) {
  el.hidden = !option;
  if (!option) return;
  el.innerHTML = ic('wallet');
  const amount = document.createElement('span');
  amount.textContent = shortAmount(option.amount || '0');
  el.append(amount);
  el.title = `Balance: ${amount.textContent} ${option.symbol}`;
}

function renderSwapLegs() {
  const catalog = swapCatalog();
  if (!swapHeldCatalog().some((o) => o.value === swapFromValue)) swapFromValue = 'ton';
  if (swapToValue && !catalog.some((o) => o.value === swapToValue)) swapToValue = '';
  renderTokenPill(swapFromBtn, catalog.find((o) => o.value === swapFromValue));
  renderTokenPill(swapToBtn, catalog.find((o) => o.value === swapToValue));
  renderLegBalance(swapFromBalanceEl, catalog.find((o) => o.value === swapFromValue));
  renderLegBalance(swapToBalanceEl, catalog.find((o) => o.value === swapToValue));
}

// Token picker: one bottom sheet for both legs. Rows show the logo, symbol
// and name — never the contract address.
let tokenPickSource: () => TokenOption[] = () => [];
let tokenPickCurrent = '';
let tokenPickHandler: ((value: string) => void) | null = null;

function renderTokenPick() {
  tokenPickList.replaceChildren(
    ...tokenPickSource().map((o) => {
      const row = assetRow({ ...o, button: true });
      row.classList.toggle('is-current', o.value === tokenPickCurrent);
      row.addEventListener('click', () => {
        const handler = tokenPickHandler;
        closeSheets();
        handler?.(o.value);
      });
      return row;
    }),
  );
}

function openTokenPicker(opener: HTMLElement, source: () => TokenOption[], current: string, note: string, onPick: (value: string) => void) {
  closeSheets();
  sheetOpener = opener;
  tokenPickSource = source;
  tokenPickCurrent = current;
  tokenPickHandler = onPick;
  tokenPickNote.textContent = note;
  renderTokenPick();
  tokenPickSheet.hidden = false;
  loadTokenMeta().catch(() => {});
}

swapFromBtn.addEventListener('click', () => {
  openTokenPicker(swapFromBtn, swapHeldCatalog, swapFromValue, 'Only GRAM and the tokens you hold can be swapped from.', (value) => {
    swapFromValue = value;
    if (swapToValue === value) swapToValue = '';
    swapFromAmountInput.value = '';
    swapAllPending = false;
    renderSwapLegs();
    refreshSwapQuote();
  });
});

swapToBtn.addEventListener('click', () => {
  openTokenPicker(swapToBtn, swapCatalog, swapToValue, 'Token missing? Add it with “Add token” on the Home screen.', (value) => {
    swapToValue = value;
    renderSwapLegs();
    refreshSwapQuote();
  });
});

/**
 * The full amount the ALL button would fill in for the current "from"
 * asset. For TON, `TOKEN_TRANSFER_GAS` is held back — Omniston attaches the
 * swap's own gas on top of the input amount, so offering the literal full
 * balance would build a transaction the wallet can't actually cover.
 */
function swapFromMaxUnits(): { units: bigint; decimals: number } {
  const jetton = selectedSwapFromJetton();
  if (jetton) return { units: jetton.balance, decimals: jetton.decimals };
  const units = lastTonBalance > TOKEN_TRANSFER_GAS ? lastTonBalance - TOKEN_TRANSFER_GAS : 0n;
  return { units, decimals: 9 };
}

/** Set by ALL on a GRAM swap: the amount is re-fitted to each quote's gas budget until the user types their own. */
let swapAllPending = false;

swapMaxBtn.addEventListener('click', () => {
  const { units, decimals } = swapFromMaxUnits();
  swapAllPending = !selectedSwapFromJetton();
  swapFromAmountInput.value = formatUnits(units, decimals);
  refreshSwapQuote();
});

/** The tab is only usable on mainnet — Omniston has no testnet relay. Its
 * client is fetched here, on first use, rather than with the page. */
async function openSwapTab() {
  const onMainnet = wallet?.network === 'mainnet';
  swapTestnetNote.hidden = onMainnet;
  swapBody.hidden = !onMainnet;
  if (onMainnet && !omniston) {
    const { createOmniston } = await import('./omniston');
    // The wallet may have disconnected or switched while that loaded.
    if (wallet?.network === 'mainnet' && !omniston) {
      omniston = createOmniston();
    }
  }
  refreshSwapQuote();
}

function swapDestination(value: string): { asset: SwapAsset; symbol: string } {
  if (value === 'ton') return { asset: { kind: 'native' }, symbol: 'GRAM' };
  return {
    asset: { kind: 'jetton', master: Address.parseRaw(value) },
    symbol: swapCatalog().find((o) => o.value === value)?.symbol ?? 'jetton',
  };
}

/** Decimals for a swap destination, when known locally — native TON's are
 * fixed, the pinned registry carries its own, a held token's come with the
 * holding, and an added jetton's were fetched from the indexer when it was
 * added. */
function swapDestinationDecimals(asset: SwapAsset): number | undefined {
  if (asset.kind === 'native') return 9;
  const known = findKnownMainnetJetton(asset.master);
  if (known) return known.decimals;
  const held = jettons.find((j) => j.master.equals(asset.master));
  if (held && !held.decimalsDisputed) return held.decimals;
  const custom = customJettons.find((j) => Address.parse(j.master).equals(asset.master));
  return custom?.decimals;
}

addTokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wallet) return;
  const raw = addTokenInput.value.trim();
  if (!raw) return;

  let master: Address;
  try {
    master = Address.parse(raw);
  } catch {
    showStatus('That address could not be parsed.', 'error');
    return;
  }

  addTokenBtn.disabled = true;
  try {
    showStatus('Looking up the token…');
    const info = await wallet.getJettonMaster(master);
    if (!info) {
      showStatus('No jetton found at that address.', 'error');
      return;
    }
    const entry: CustomJetton = { ...info, master: master.toString({ bounceable: true }) };
    customJettons = [...customJettons.filter((j) => !Address.parse(j.master).equals(master)), entry];
    saveCustomJettons();
    addTokenInput.value = '';
    closeSheets();
    renderAssets(lastTonBalance);
    renderSwapLegs();
    showStatus(`Added ${entry.symbol} — ${entry.name}. Unverified — anyone can name a jetton anything.`, 'success');
  } catch (err) {
    showStatus(`Lookup failed: ${(err as Error)?.message ?? String(err)}`, 'error');
  } finally {
    addTokenBtn.disabled = false;
  }
});

/**
 * Flips "from" and "to" — the same TON↔jetton toggle other wallets show as
 * arrows next to the pair. The new "from" must be something the wallet
 * actually holds, so a flip into an unheld jetton is refused rather than
 * left half-applied.
 */
swapFlipBtn.addEventListener('click', () => {
  if (!swapToValue) {
    showStatus('Pick the token to swap into first.', 'error');
    return;
  }
  if (!swapHeldCatalog().some((o) => o.value === swapToValue)) {
    const symbol = swapCatalog().find((o) => o.value === swapToValue)?.symbol ?? 'that token';
    showStatus(`You don't hold ${symbol} to swap from it.`, 'error');
    return;
  }
  [swapFromValue, swapToValue] = [swapToValue, swapFromValue];
  swapFromAmountInput.value = '';
  swapAllPending = false;
  renderSwapLegs();
  statusEl.hidden = true;
  refreshSwapQuote();
});

// ----------------------------------------------------- live swap quote
//
// Like the STON.fi app: pick the pair, type an amount, and Omniston's quote
// stream is followed in the background — a fresh quote about every ten
// seconds — with the figures redrawn as each arrives. "Swap" takes the latest
// one, closes the stream while it is reviewed and signed, then it resumes.

const SWAP_SETTINGS_KEY = 'cw-swap-settings';
/** The relay sends a quote about every 10 s; nothing for this long means the stream has stalled. */
const SWAP_QUOTE_STALE_MS = 35_000;

/** STON.fi's own defaults: auto slippage on, capped at 1%. */
let swapSlippagePct = 1;
let swapAutoSlippage = true;

try {
  const saved = JSON.parse(localStorage.getItem(SWAP_SETTINGS_KEY) ?? 'null');
  if (typeof saved?.pct === 'number' && saved.pct >= 0.01 && saved.pct <= 50) swapSlippagePct = saved.pct;
  if (typeof saved?.auto === 'boolean') swapAutoSlippage = saved.auto;
} catch {
  // Unreadable storage: the defaults stand.
}

function renderSwapSettings() {
  swapAutoSlippageInput.checked = swapAutoSlippage;
  if (document.activeElement !== swapSlippageInput) swapSlippageInput.value = String(swapSlippagePct);
  for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-slippage]')) {
    const active = Number(chip.dataset.slippage) === swapSlippagePct;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  }
}

function applySwapSettings(pct: number, auto: boolean) {
  swapSlippagePct = pct;
  swapAutoSlippage = auto;
  try {
    localStorage.setItem(SWAP_SETTINGS_KEY, JSON.stringify({ pct, auto }));
  } catch {
    // Private browsing / quota — the choice just won't survive a reload.
  }
  renderSwapSettings();
  refreshSwapQuote();
}

swapSlippageInput.addEventListener('input', () => {
  const pct = Number(swapSlippageInput.value.replace(',', '.'));
  if (swapSlippageInput.value.trim() && Number.isFinite(pct) && pct >= 0.01 && pct <= 50) {
    applySwapSettings(pct, swapAutoSlippage);
  }
});
swapSlippageInput.addEventListener('blur', renderSwapSettings);
for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-slippage]')) {
  chip.addEventListener('click', () => {
    swapSlippageInput.value = chip.dataset.slippage!;
    applySwapSettings(Number(chip.dataset.slippage), swapAutoSlippage);
  });
}
swapAutoSlippageInput.addEventListener('change', () => applySwapSettings(swapSlippagePct, swapAutoSlippageInput.checked));
renderSwapSettings();

let stopSwapStream: (() => void) | null = null;
let liveSwapQuote: { ctx: SwapQuoteContext; at: number } | null = null;
let swapRefreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Bumped on every restart so a stream that was just closed can't draw late. */
let swapStreamSeq = 0;

function stopSwapWatch() {
  if (swapRefreshTimer !== null) clearTimeout(swapRefreshTimer);
  swapRefreshTimer = null;
  swapStreamSeq++;
  stopSwapStream?.();
  stopSwapStream = null;
}

function setSwapLive(text: string | null, kind: 'info' | 'error' = 'info') {
  swapLiveEl.hidden = text === null;
  swapLiveEl.classList.toggle('is-error', kind === 'error');
  swapLiveText.textContent = text ?? '';
}

function clearSwapOutput() {
  liveSwapQuote = null;
  swapToAmountEl.textContent = '0';
  swapDetailsEl.hidden = true;
  swapQuoteBtn.disabled = true;
}

/** Minimum the swap will accept: Omniston's recommendation on auto, the user's cap otherwise. */
function swapMinUnits(ctx: SwapQuoteContext): string {
  const sw = (ctx.quote as QuoteOfSwap).settlementData.value;
  return ctx.autoSlippage ? sw.recommendedMinOutputAmount : sw.minOutputAmount;
}

function renderSwapQuote(ctx: SwapQuoteContext) {
  const quote = ctx.quote as QuoteOfSwap;
  const sw = quote.settlementData.value;
  swapToAmountEl.textContent = shortAmount(formatUnits(BigInt(quote.outputUnits), ctx.toDecimals));
  const price = Number(formatUnits(BigInt(quote.outputUnits), ctx.toDecimals)) / Number(formatUnits(BigInt(quote.inputUnits), ctx.fromDecimals));
  swapRateEl.textContent = Number.isFinite(price) ? `1 ${ctx.fromSymbol} ≈ ${shortAmount(price.toFixed(10))} ${ctx.toSymbol}` : '—';
  swapMinEl.textContent = formatSwapAmount(swapMinUnits(ctx), ctx.toDecimals, ctx.toSymbol);
  swapImpactEl.textContent = sw.priceImpactPips !== undefined ? `${(sw.priceImpactPips / 10_000).toFixed(2)}%` : '—';
  swapSlippageShownEl.textContent = ctx.autoSlippage
    ? `${sw.recommendedSlippagePips / 10_000}% (auto)`
    : `${swapSlippagePct}%`;
  swapDetailsEl.hidden = false;
  swapQuoteBtn.disabled = false;
  setSwapLive('Live quote — updates automatically');
}

/** (Re)starts following the quote for what is entered now; stops and clears if it is incomplete. */
function refreshSwapQuote() {
  stopSwapWatch();
  clearSwapOutput();
  if (!wallet || !omniston || wallet.network !== 'mainnet' || viewSwap.hidden) return setSwapLive(null);
  if (!swapToValue || swapToValue === swapFromValue) return setSwapLive(swapToValue ? 'Pick a different token to swap into.' : 'Pick the token to swap into.');

  const fromJetton = selectedSwapFromJetton();
  const fromSymbol = fromJetton ? fromJetton.symbol : 'GRAM';
  const fromDecimals = fromJetton ? fromJetton.decimals : 9;
  const from: SwapAsset = fromJetton ? { kind: 'jetton', master: fromJetton.master } : { kind: 'native' };
  const to = swapDestination(swapToValue);

  if (!swapFromAmountInput.value.trim()) return setSwapLive(null);
  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(swapFromAmountInput.value, fromDecimals);
  } catch (err) {
    return setSwapLive((err as Error).message, 'error');
  }
  if (amountUnits <= 0n) return setSwapLive(null);

  // Every token the picker offers has known decimals; should one ever not,
  // an amount that can't be shown right is not quoted at all.
  const toDecimals = swapDestinationDecimals(to.asset);
  if (toDecimals === undefined) return setSwapLive(`${to.symbol}'s decimals are unknown, so it can't be swapped into.`, 'error');
  const autoSlippage = swapAutoSlippage;
  const seq = swapStreamSeq;
  const client = omniston;
  setSwapLive('Getting a quote…');
  import('./omniston').then(({ watchQuotes }) => {
    if (seq !== swapStreamSeq) return;
    stopSwapStream = watchQuotes(
      client,
      { from, to: to.asset, amountUnits, slippagePips: Math.round(swapSlippagePct * 10_000) },
      {
        onQuote: (quote) => {
          if (seq !== swapStreamSeq || !isSwapQuote(quote)) return;
          try {
            checkQuoteMatchesRequest(quote, { from, to: to.asset, amountUnits });
          } catch (err) {
            clearSwapOutput();
            setSwapLive((err as Error).message, 'error');
            return;
          }
          if (swapAllPending && from.kind === 'native' && quote.gasBudget !== undefined) {
            // ALL: leave the quote's own gas budget and the fee reserve, then ask again.
            const fitted = swapAllAmount(lastTonBalance, BigInt(quote.gasBudget));
            if (fitted === 0n) {
              clearSwapOutput();
              setSwapLive('Not enough GRAM left to pay for the swap\'s gas.', 'error');
              return;
            }
            // Only ever down: a route whose gas moves with the amount can't make this loop.
            if (amountUnits > fitted) {
              swapFromAmountInput.value = fromNano(fitted);
              refreshSwapQuote();
              return;
            }
          }
          const ctx: SwapQuoteContext = {
            quote, from, to: to.asset, fromSymbol, toSymbol: to.symbol, fromDecimals, toDecimals, amountUnits, autoSlippage,
          };
          liveSwapQuote = { ctx, at: Date.now() };
          renderSwapQuote(ctx);
        },
        onNoQuote: () => {
          if (seq !== swapStreamSeq) return;
          clearSwapOutput();
          setSwapLive('No route found for this pair right now.', 'error');
        },
        onError: (err) => {
          if (seq !== swapStreamSeq) return;
          clearSwapOutput();
          setSwapLive(`Quote failed: ${err.message}`, 'error');
        },
      },
    );
  }).catch((err: Error) => setSwapLive(`Quote failed: ${err.message}`, 'error'));
}

/** Typing blanks the old result at once; the new quote is asked for once the typing pauses. */
swapFromAmountInput.addEventListener('input', () => {
  swapAllPending = false;
  stopSwapWatch();
  clearSwapOutput();
  setSwapLive(null);
  swapRefreshTimer = setTimeout(refreshSwapQuote, 400);
});

swapQuoteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wallet || !omniston) return;
  if (!liveSwapQuote) {
    showStatus('Waiting for a quote…');
    return;
  }
  if (Date.now() - liveSwapQuote.at > SWAP_QUOTE_STALE_MS) {
    showStatus('The quote is out of date — wait a moment for the next one.', 'error');
    return;
  }
  // The quote under review stays on screen while the stream is closed.
  const ctx = liveSwapQuote.ctx;
  stopSwapWatch();
  try {
    await confirmAndSignSwap(ctx);
  } finally {
    refreshSwapQuote();
  }
});

/** The quote goes up in the same dialog as every other confirmation; only
 * "Sign & Swap" builds the transaction and asks the device. */
async function confirmAndSignSwap(ctx: SwapQuoteContext) {
  if (!wallet || !omniston) return;
  const { quote, from, amountUnits, fromSymbol, toSymbol, fromDecimals, toDecimals } = ctx;
  if (!isSwapQuote(quote)) return;

  const confirmed = await confirmModal({
    title: 'CONFIRM SWAP',
    fields: [
      ['you send', formatSwapAmount(quote.inputUnits, fromDecimals, fromSymbol)],
      ['you receive (est.)', formatSwapAmount(quote.outputUnits, toDecimals, toSymbol)],
      ['minimum received', formatSwapAmount(swapMinUnits(ctx), toDecimals, toSymbol)],
    ],
    confirmLabel: 'Sign & Swap',
  });
  if (!confirmed) return;

  resultEl.hidden = true;
  try {
    showStatus('Building the swap transaction…');
    const { buildSwapTransaction } = await import('./omniston');
    const { messages, totalValue } = await buildSwapTransaction(omniston, quote.quoteId, wallet.address, ctx.autoSlippage);
    const prepared = await wallet.buildAndSignSwap(
      ble,
      {
        messages,
        totalValue,
        from,
        amountUnits,
        token: from.kind === 'jetton' ? { symbol: fromSymbol, decimals: fromDecimals } : undefined,
        display: {
          amount:
            `Swap ${formatSwapAmount(quote.inputUnits, fromDecimals, fromSymbol)} → ` +
            formatSwapAmount(quote.outputUnits, toDecimals, toSymbol),
        },
      },
      onSignStatus,
      confirmFee,
    );
    await broadcastAndConfirm(prepared, `Swap sent. Waiting for the network to confirm…`);
  } catch (err) {
    if (err instanceof SendCancelledError) {
      showStatus('Cancelled.');
      return;
    }
    console.error('swap failed', err);
    showStatus(`Swap failed: ${(err as Error)?.message ?? String(err)}`, 'error');
  }
}

/** The headline balance, in USD — empty when there is no price to value it
 * with (testnet coins have none). The GRAM amount has its own row in the
 * asset list below. */
function renderBalance() {
  const gramUsd = usdPrices.get(GRAM_ASSET);
  if (wallet?.network !== 'mainnet') {
    balanceEl.replaceChildren();
    balanceSubEl.hidden = true;
    return;
  }
  const value = document.createElement('span');
  const unit = document.createElement('span');
  unit.className = 'balance-unit';
  unit.textContent = 'USD';
  // Zero until the first prices arrive, so the screen opens without waiting.
  if (gramUsd === undefined) {
    value.textContent = formatUsdt(0);
    balanceEl.replaceChildren(value, unit);
    balanceSubEl.hidden = true;
    return;
  }

  // Held tokens count only with a trusted price, and never those flagged as
  // scams: a fake token can sit in a pool at any price and must not inflate the total.
  const holdings = [{ amount: Number(fromNano(lastTonBalance)), usd: gramUsd }];
  let unpriced = 0;
  for (const j of jettons.filter((t) => !t.isScam)) {
    const usd = usdPrices.get(j.master.toString({ bounceable: true }));
    if (usd === undefined || j.decimalsDisputed) unpriced++;
    else holdings.push({ amount: Number(formatUnits(j.balance, j.decimals)), usd });
  }
  value.textContent = formatUsdt(totalInUsdt(holdings, usdPrices.get(USDT_ASSET) ?? 1));
  balanceEl.replaceChildren(value, unit);

  // Only what the total leaves out.
  balanceSubEl.hidden = unpriced === 0;
  balanceSubEl.textContent = `${unpriced} token${unpriced === 1 ? '' : 's'} without a price, not counted`;
}

/** Prices GRAM, USD₮ and what the wallet holds — a public price lookup that carries no address. */
async function loadPrices() {
  if (wallet?.network !== 'mainnet') return;
  const current = wallet;
  const prices = await fetchUsdPrices([GRAM_ASSET, USDT_ASSET, ...jettons.filter((t) => !t.isScam).map((j) => j.master.toString({ bounceable: true }))]);
  if (wallet !== current) return;
  usdPrices = prices;
  pricesLoaded = true;
  renderBalance();
  renderAssets(lastTonBalance);
}

// Prices move while the page sits open; balances wait for Refresh as before.
setInterval(() => {
  if (!document.hidden) loadPrices().catch(() => {});
}, 60_000);

async function refreshWalletInfo() {
  if (!wallet) return;
  // The indexer is a separate service from the RPC endpoint and fails
  // separately — a rate-limited token list must not take the TON balance
  // and the send form down with it. Caught here so it can run alongside.
  const jettonsRequest = wallet.getJettons().catch((err: unknown) => ({ failed: err as Error }));
  const own = await wallet.getOwnState();
  const seqno = await wallet.getSeqno(own);
  const balance = own.balance;
  lastTonBalance = balance;
  renderBalance();
  renderAssets(balance);
  seqnoEl.textContent = String(seqno);

  const found = await jettonsRequest;
  if ('failed' in found) {
    jettons = [];
    showStatus(`Token list unavailable: ${found.failed.message}`, 'error');
  } else {
    jettons = found;
  }
  renderAssets(balance);
  populateAssetSelect();
  renderBalance();
  loadTokenMeta().catch(() => {});
  loadPrices().catch(() => {
    // No prices: the balance stays as it was.
  });
}

// ------------------------------------------------------------- history

const HISTORY_PAGE = 30;
let history: HistoryItem[] = [];
let historyLoaded = false;
let historyHasMore = false;
let historyLoading = false;
/** How many records the indexer has handed out so far, hidden ones included. */
let historyOffset = 0;

const HISTORY_ICON = { ton: 'send', jetton: 'send', nft: 'apps', swap: 'swap', call: 'cpu' } as const;

function historyTitle(item: HistoryItem): string {
  switch (item.kind) {
    case 'swap':
      return 'Swap';
    case 'nft':
      return item.outgoing ? 'NFT sent' : 'NFT received';
    case 'call':
      return 'Contract call';
    default:
      return item.outgoing ? 'Sent' : 'Received';
  }
}

function historyRow(item: HistoryItem): HTMLElement {
  const row = document.createElement(item.hash ? 'a' : 'div');
  row.className = 'asset history-row';
  if (row instanceof HTMLAnchorElement && item.hash && wallet) {
    const base = wallet.network === 'testnet' ? 'https://testnet.tonscan.org' : 'https://tonscan.org';
    row.href = `${base}/tx/${item.hash}`;
    row.target = '_blank';
    row.rel = 'noopener';
  }

  const icon = document.createElement('span');
  icon.className = 'asset-icon history-icon';
  icon.innerHTML = ic(item.kind === 'ton' || item.kind === 'jetton' ? (item.outgoing ? 'send' : 'receive') : HISTORY_ICON[item.kind]);

  const title = document.createElement('span');
  title.className = 'asset-symbol';
  title.textContent = historyTitle(item);
  const top = document.createElement('span');
  top.className = 'asset-top';
  top.appendChild(title);
  if (!item.success) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-warn';
    badge.textContent = 'failed';
    top.appendChild(badge);
  }
  // Anyone can mint a token called "USD₮" and send it here to make it look
  // as if they paid; only the pinned registry says which one is real.
  if (item.legs.some((leg) => !leg.verified)) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-warn';
    badge.textContent = 'unverified';
    top.appendChild(badge);
  }

  const detail = document.createElement('span');
  detail.className = 'asset-name';
  const when = new Date(item.time * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const who = item.counterparty ? (item.outgoing ? 'to' : 'from') : item.nftName;
  detail.textContent = [who, when].filter(Boolean).join(' · ');

  const text = document.createElement('span');
  text.className = 'asset-text';
  text.append(top, detail);
  // In full: a dust transfer from a look-alike address that shares the first
  // and last characters is how address poisoning gets copied into a send.
  if (item.counterparty) {
    const address = document.createElement('span');
    address.className = 'asset-name history-address';
    address.textContent = item.counterparty.toString({ bounceable: false, testOnly: wallet?.network === 'testnet' });
    text.appendChild(address);
  }
  if (item.comment) {
    const comment = document.createElement('span');
    comment.className = 'asset-name history-comment';
    comment.textContent = item.comment;
    text.appendChild(comment);
  }

  const amounts = document.createElement('span');
  amounts.className = 'asset-amount history-amounts';
  for (const leg of item.legs) {
    const line = document.createElement('span');
    line.className = leg.incoming ? 'history-in' : 'history-out';
    line.textContent = `${leg.incoming ? '+' : '−'}${shortAmount(leg.amount)} ${leg.symbol}`;
    amounts.appendChild(line);
  }

  row.append(icon, text, amounts);
  return row;
}

function renderHistory() {
  historyListEl.replaceChildren(...history.map(historyRow));
  historyEmptyEl.hidden = !historyLoaded || history.length > 0;
  historyMoreBtn.hidden = !historyHasMore;
}

/** The newest page again (reset), or the page after the ones already shown. */
async function loadHistory(reset: boolean) {
  if (!wallet || historyLoading) return;
  const current = wallet;
  historyLoading = true;
  historyRefreshBtn.disabled = true;
  historyMoreBtn.disabled = true;
  try {
    const page = await current.getHistory(reset ? 0 : historyOffset, HISTORY_PAGE);
    if (wallet !== current) return;
    historyOffset = (reset ? 0 : historyOffset) + HISTORY_PAGE;
    const seen = new Set(reset ? [] : history.map((i) => i.id));
    history = [...(reset ? [] : history), ...page.items.filter((i) => !seen.has(i.id))];
    historyHasMore = page.hasMore;
    historyLoaded = true;
    renderHistory();
  } finally {
    historyLoading = false;
    historyRefreshBtn.disabled = false;
    historyMoreBtn.disabled = false;
  }
}
historyRefreshBtn.addEventListener('click', () => {
  loadHistory(true).catch((err) => showStatus(`Loading history failed: ${(err as Error).message}`, 'error'));
});
historyMoreBtn.addEventListener('click', () => {
  loadHistory(false).catch((err) => showStatus(`Loading history failed: ${(err as Error).message}`, 'error'));
});

// ---------------------------------------------------------------- NFTs

function renderNfts() {
  const cards: HTMLElement[] = [];
  for (const item of nfts) {
    const card = document.createElement('div');
    card.className = 'nft-card';

    const thumb = document.createElement('div');
    thumb.className = 'nft-thumb';
    if (item.image) {
      const img = document.createElement('img');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      thumb.appendChild(img);
    } else {
      thumb.textContent = 'no image';
    }

    const name = document.createElement('div');
    name.className = 'nft-name';
    name.textContent = item.name;

    const collection = document.createElement('div');
    collection.className = 'nft-collection';
    collection.textContent = item.collection ?? 'no collection';

    card.append(thumb, name, collection);

    if (item.isScam) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-warn';
      badge.textContent = 'flagged';
      card.appendChild(badge);
    }

    const btn = document.createElement('button');
    if (item.onSale) {
      btn.textContent = 'On sale';
      btn.disabled = true;
      btn.title = 'Held by a sale contract — cancel the sale before transferring.';
    } else {
      btn.textContent = 'Transfer';
      btn.addEventListener('click', () => selectNft(item));
    }
    card.appendChild(btn);
    cards.push(card);
  }
  nftListEl.replaceChildren(...cards);
  nftEmptyEl.hidden = nfts.length > 0;
  nftEmptyEl.textContent = 'This wallet holds no NFTs.';
}

function selectNft(item: NftItem) {
  selectedNft = item;
  nftTransferNameEl.textContent = item.collection ? `${item.name} · ${item.collection}` : item.name;
  nftTransferEl.hidden = false;
}

async function loadNfts() {
  if (!wallet) return;
  nftRefreshBtn.disabled = true;
  try {
    nftEmptyEl.hidden = false;
    nftEmptyEl.textContent = 'Loading…';
    nfts = await wallet.getNfts();
    nftsLoaded = true;
    // Whatever was being transferred may no longer be here.
    selectedNft = null;
    nftTransferEl.hidden = true;
    renderNfts();
  } catch (err) {
    nfts = [];
    nftListEl.replaceChildren();
    nftEmptyEl.hidden = false;
    nftEmptyEl.textContent = `NFTs could not be loaded: ${(err as Error).message}`;
  } finally {
    nftRefreshBtn.disabled = false;
  }
}

nftRefreshBtn.addEventListener('click', () => {
  loadNfts().catch((err) => showStatus(`Loading NFTs failed: ${(err as Error).message}`, 'error'));
});

nftCancelBtn.addEventListener('click', () => {
  selectedNft = null;
  nftTransferEl.hidden = true;
  nftForm.reset();
});

async function enterWalletSection() {
  const pubkey = await ble.getPubkey();
  const network = networkSelect.value as Network;
  wallet = new TonWallet(network, pubkey);
  customJettons = loadCustomJettons(network);

  // Non-bounceable and testnet-flagged where applicable: this is the address
  // someone hands out to receive coins, and it has to be accepted even
  // before the wallet contract is deployed.
  addressEl.textContent = formatOwnAddress(wallet.address, network);
  addressQrEl.innerHTML = addressQrSvg(addressEl.textContent);
  netChip.textContent = network;
  createWalletSection.hidden = true;
  seedPromptSection.hidden = true;
  pinGateSection.hidden = true;
  walletSection.hidden = false;
  connectSection.hidden = true;
  // The network is baked into the TonClient built above; changing it now
  // would leave the displayed address and balance pointing at the other
  // chain. Disconnect is the way to switch.
  networkSelect.disabled = true;

  // The screen opens on zeros; balances and prices fill in as the network
  // answers, and a slow or failed answer never holds the screen back.
  renderAssets(lastTonBalance);
  populateAssetSelect();
  renderBalance();

  showStatus('Connected.', 'success');
  startTonConnect();
  refreshWalletInfo().catch((err) => showStatus(`Balance update failed: ${(err as Error).message}`, 'error'));
  await refreshFirmwareVersion();
}

async function refreshFirmwareVersion() {
  try {
    fwVersionEl.textContent = await ble.getFirmwareVersion();
  } catch {
    // Older firmware has no version characteristic — not fatal, it just
    // means updates can't be offered against it.
    fwVersionEl.textContent = 'unknown';
  }
  fwLatestEl.textContent = manifestConfigured() ? 'not checked' : 'no release feed configured';
  fwCheckBtn.disabled = !manifestConfigured();

  if (!manifestConfigured()) return;
  // Checked without being asked: once Secure Boot and Flash Encryption are
  // on, USB flashing is gone, so this is the only route
  // a security fix can take, and a device only gets one if its owner happens
  // to press a button at the bottom of the page. A failed check is reported in the firmware block
  // and left there — it must not look like the connection went wrong.
  await checkForUpdate();
}

/** mode picks which of the two pin-gate-section sub-forms is shown: 'set'
 * for a wallet with no PIN yet, 'unlock' for one that already has one — the
 * device only ever offers one of these at a time (see WALLET_STATUS_PIN_NOT_SET). */
function enterPinGate(message: string, mode: 'set' | 'unlock') {
  connectSection.hidden = true;
  createWalletSection.hidden = true;
  seedPromptSection.hidden = true;
  pinGateSection.hidden = false;
  pinSetBlock.hidden = mode !== 'set';
  pinUnlockBlock.hidden = mode !== 'unlock';
  showStatus(message, 'info');
}

/** Set on connect: the device has a PIN but no wallet yet (or no PIN at
 * all), so a correct PIN leads to wallet creation rather than the wallet. */
let walletMissing = false;

function enterCreateWallet() {
  connectSection.hidden = true;
  pinGateSection.hidden = true;
  createWalletSection.hidden = false;
  showStatus('Unlocked — no wallet on this device yet. Create one.', 'info');
}

function enterSeedPrompt() {
  connectSection.hidden = true;
  createWalletSection.hidden = true;
  seedPromptSection.hidden = false;
  seedPromptContinueBtn.hidden = true; // only revealed once the on-device viewing has run to completion — see runShowSeed()
  showStatus('Wallet created.', 'success');
}

connectBtn.addEventListener('click', async () => {
  connectBtn.disabled = true;
  try {
    showStatus('Connecting to device…');
    await ble.connect();
    const status = await ble.getStatus();

    // The PIN comes first on the device: the wallet key is encrypted under
    // it the moment it is created, so a blank device asks for a PIN, and one
    // with a PIN but no wallet yet is unlocked before creating one.
    if (status === WalletStatus.PinNotSet) {
      walletMissing = true;
      enterPinGate('Connected — a new device. Set a PIN to begin.', 'set');
      return;
    }

    walletMissing = status === WalletStatus.NoWallet;
    enterPinGate('Connected — enter the device PIN to continue.', 'unlock');
  } catch (err) {
    showStatus(`Connection failed: ${(err as Error).message}`, 'error');
  } finally {
    connectBtn.disabled = false;
  }
});

createWalletBtn.addEventListener('click', async () => {
  createWalletBtn.disabled = true;
  try {
    const status = await ble.createWallet((s) => {
      if (s === WalletStatus.CreateAwaitingConfirm) {
        startConfirmCountdown('Press the confirm button on the device');
      } else if (s === WalletStatus.CreateGenerating) {
        showStatus('Generating your wallet key on the device — usually 10-20 seconds, sometimes over a minute. Please wait…', 'info');
      }
    });
    if (status === WalletStatus.Created) {
      walletMissing = false;
      enterSeedPrompt();
    } else {
      showStatus('Wallet creation was rejected or timed out on the device.', 'error');
    }
  } catch (err) {
    showStatus(`Wallet creation failed: ${(err as Error).message}`, 'error');
  } finally {
    createWalletBtn.disabled = false;
  }
});

refreshBtn.addEventListener('click', () => {
  refreshWalletInfo().catch((err) => showStatus(`Refresh failed: ${(err as Error).message}`, 'error'));
});

/** Shared by both places that can trigger the on-device seed display: the
 * post-creation prompt (with the on-device check) and the always-available
 * button in wallet-section (without). */
async function runShowSeed(check = false): Promise<WalletStatus> {
  const status = await ble.showSeed((s) => {
    if (s === WalletStatus.SeedAwaitingConfirm) {
      startConfirmCountdown('Press the confirm button on the device');
    } else if (s === WalletStatus.SeedShowing) {
      showStatus(
        check
          ? 'Look at the device screen — take your time writing down all 24 words. Then press the device button: the device will ask you for three of the words.'
          : 'Look at the device screen — take your time writing down all 24 words, then press the device button to finish.',
        'info',
      );
    } else if (s === WalletStatus.SeedChecking) {
      showStatus(
        'Answer on the device using what you wrote down: a short press highlights the next word, holding the button for a second picks it.',
        'info',
      );
    }
  }, check);
  if (status === WalletStatus.SeedDone) {
    showStatus('Done — the phrase is back off-screen on the device.', 'success');
  } else if (status === WalletStatus.SeedChecked) {
    showStatus('Checked — your written copy matches the device.', 'success');
  } else if (status === WalletStatus.SeedCheckFailed) {
    showStatus(
      "The check didn't pass (a wrong word, or it was left unanswered). View the phrase again and compare it with what you wrote down.",
      'error',
    );
  } else if (status === WalletStatus.SeedUnavailable) {
    showStatus('This wallet was created before backup phrases were supported — no phrase to show.', 'error');
  } else {
    showStatus('Showing the seed phrase was rejected or timed out on the device.', 'error');
  }
  return status;
}

showSeedBtn.addEventListener('click', async () => {
  showSeedBtn.disabled = true;
  try {
    await runShowSeed();
  } catch (err) {
    showStatus(`Show seed phrase failed: ${(err as Error).message}`, 'error');
  } finally {
    showSeedBtn.disabled = false;
  }
});

seedPromptViewBtn.addEventListener('click', async () => {
  seedPromptViewBtn.disabled = true;
  try {
    const status = await runShowSeed(true);
    // Only unlock "Continue" once the on-device check has passed (or there
    // was genuinely nothing to show) — a failed, rejected or timed-out
    // attempt must not let someone skip past the backup step.
    if (status === WalletStatus.SeedChecked || status === WalletStatus.SeedUnavailable) {
      seedPromptContinueBtn.hidden = false;
    }
  } catch (err) {
    showStatus(`Show seed phrase failed: ${(err as Error).message}`, 'error');
  } finally {
    seedPromptViewBtn.disabled = false;
  }
});

seedPromptContinueBtn.addEventListener('click', () => {
  enterWalletSection().catch((err) => showStatus(`Opening the wallet failed: ${(err as Error).message}`, 'error'));
});

function pinStatusMessage(status: WalletStatus): { text: string; kind: 'error' | 'success' } {
  switch (status) {
    case WalletStatus.PinOk:
      return { text: 'PIN accepted — device unlocked for this connection.', kind: 'success' };
    case WalletStatus.PinWrong:
      return { text: 'Wrong PIN.', kind: 'error' };
    case WalletStatus.PinLocked:
      return { text: 'Too many wrong attempts — locked out for a while, try again later.', kind: 'error' };
    case WalletStatus.PinAlreadySet:
      return { text: 'A PIN is already set on this device — use Unlock, not Set.', kind: 'error' };
    case WalletStatus.PinSetRejected:
      return { text: 'Setting the PIN was rejected or timed out on the device.', kind: 'error' };
    case WalletStatus.Busy:
      return { text: 'The device is waiting for another confirmation — finish it first.', kind: 'error' };
    default:
      return { text: 'PIN must be 6-10 characters.', kind: 'error' };
  }
}

async function handlePinResult(status: WalletStatus, inputEl: HTMLInputElement) {
  const { text, kind } = pinStatusMessage(status);
  inputEl.value = '';
  if (status === WalletStatus.PinOk) {
    if (walletMissing) {
      enterCreateWallet();
      return;
    }
    await enterWalletSection();
    return;
  }
  showStatus(text, kind);
}

pinUnlockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  pinVerifyBtn.disabled = true;
  try {
    const status = await ble.verifyPin(pinUnlockInput.value);
    await handlePinResult(status, pinUnlockInput);
  } catch (err) {
    showStatus(`PIN check failed: ${(err as Error).message}`, 'error');
  } finally {
    pinVerifyBtn.disabled = false;
  }
});

pinSetForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  pinSetBtn.disabled = true;
  try {
    const status = await ble.setPin(pinSetInput.value, (s) => {
      if (s === WalletStatus.PinSetAwaitingConfirm) {
        showStatus('Press the confirm button on the device to set this PIN.');
      }
    });
    await handlePinResult(status, pinSetInput);
  } catch (err) {
    showStatus(`Setting PIN failed: ${(err as Error).message}`, 'error');
  } finally {
    pinSetBtn.disabled = false;
  }
});

const confirmModalOverlay = document.querySelector<HTMLDivElement>('#confirm-modal-overlay')!;
const confirmModalTitle = document.querySelector<HTMLElement>('#confirm-modal-title')!;
const confirmModalMessage = document.querySelector<HTMLElement>('#confirm-modal-message')!;
const confirmModalFields = document.querySelector<HTMLDivElement>('#confirm-modal-fields')!;
const confirmModalConfirmBtn = document.querySelector<HTMLButtonElement>('#confirm-modal-confirm')!;
const confirmModalCancelBtn = document.querySelector<HTMLButtonElement>('#confirm-modal-cancel')!;

type ConfirmModalOptions = {
  title: string;
  fields?: [string, string][];
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as a destructive action. */
  danger?: boolean;
  /** Called at once with a function that closes this modal as cancelled,
   * whether it is on screen yet or still waiting its turn. */
  onDismissHandle?: (dismiss: () => void) => void;
};

/** One modal at a time: a second request waits for the first to be answered. */
let confirmModalQueue: Promise<unknown> = Promise.resolve();

/**
 * The single confirmation dialog for everything that asks the person to
 * approve something — a transfer's last look, a swap quote, a site's
 * connect or transaction request, an erase. In-app rather than
 * window.confirm() so it looks like the rest of the console. Every value is
 * set as text: some of it comes from a connected site. Escape, a click
 * outside, or Cancel answer no.
 */
function confirmModal(opts: ConfirmModalOptions): Promise<boolean> {
  let dismissed = false;
  let dismissShown: (() => void) | null = null;
  opts.onDismissHandle?.(() => {
    dismissed = true;
    dismissShown?.();
  });

  const run = confirmModalQueue.then(
    () =>
      new Promise<boolean>((resolve) => {
        if (dismissed) {
          resolve(false);
          return;
        }
        confirmModalTitle.textContent = opts.title;
        confirmModalMessage.hidden = !opts.message;
        confirmModalMessage.textContent = opts.message ?? '';
        confirmModalFields.replaceChildren(
          ...(opts.fields ?? []).map(([label, value]) => {
            const row = document.createElement('div');
            row.className = 'field';
            const l = document.createElement('span');
            l.textContent = label;
            const v = document.createElement('code');
            v.textContent = value;
            row.append(l, v);
            return row;
          }),
        );
        confirmModalConfirmBtn.textContent = opts.confirmLabel;
        confirmModalConfirmBtn.className = opts.danger ? 'btn btn-danger btn-block' : 'btn btn-primary btn-block';
        confirmModalCancelBtn.textContent = opts.cancelLabel ?? 'Cancel';
        confirmModalOverlay.hidden = false;

        const finish = (result: boolean) => {
          confirmModalOverlay.hidden = true;
          confirmModalConfirmBtn.removeEventListener('click', onConfirm);
          confirmModalCancelBtn.removeEventListener('click', onCancel);
          confirmModalOverlay.removeEventListener('click', onOverlayClick);
          document.removeEventListener('keydown', onKeydown);
          dismissShown = null;
          resolve(result);
        };
        const onConfirm = () => finish(true);
        const onCancel = () => finish(false);
        const onOverlayClick = (e: MouseEvent) => {
          if (e.target === confirmModalOverlay) finish(false);
        };
        const onKeydown = (e: KeyboardEvent) => {
          if (e.key === 'Escape') finish(false);
        };
        confirmModalConfirmBtn.addEventListener('click', onConfirm);
        confirmModalCancelBtn.addEventListener('click', onCancel);
        confirmModalOverlay.addEventListener('click', onOverlayClick);
        document.addEventListener('keydown', onKeydown);
        dismissShown = onCancel;
      }),
  );
  confirmModalQueue = run.catch(() => {});
  return run;
}

/**
 * Shown right before the device is asked to sign anything — a last look at
 * exactly what's being sent and what the network will charge for it, with
 * a chance to back out before walking over to press the physical button.
 */
const confirmFee: ConfirmFee = (feeNano, info) =>
  confirmModal({
    title: 'CONFIRM SEND',
    fields: [
      ['to', info.address],
      ['amount', info.amount],
      ['network fee (est.)', `~${shortAmount(fromNano(feeNano))} GRAM`],
    ],
    confirmLabel: 'Confirm',
  });

/** Progress reporting shared by every kind of transfer. */
function onSignStatus(status: WalletStatus) {
  if (status === WalletStatus.AwaitingConfirm) {
    startConfirmCountdown('Read the device screen: a press turns the page, holding the button for a second on the last page signs');
  } else if (status === WalletStatus.Signed) {
    showStatus('Signed. Broadcasting…');
  } else if (status === WalletStatus.Rejected) {
    showStatus('Rejected on device.', 'error');
  }
}

/**
 * Broadcasts an already-signed transfer and reports the outcome. Identical
 * for TON, jettons and NFTs: from the wallet contract's point of view all
 * three are one external message, and all three are confirmed the same way.
 */
async function broadcastAndConfirm(prepared: PreparedTransfer, sentMessage: string) {
  if (!wallet) return;
  await wallet.broadcast(prepared);

  const explorerLink = document.createElement('a');
  explorerLink.href = explorerAddressUrl(wallet.network, formatOwnAddress(wallet.address, wallet.network));
  explorerLink.target = '_blank';
  explorerLink.rel = 'noopener';
  explorerLink.textContent = 'View address on explorer';
  resultEl.hidden = false;
  resultEl.replaceChildren(explorerLink);
  if (resultHideTimer !== null) clearTimeout(resultHideTimer);
  resultHideTimer = setTimeout(() => (resultEl.hidden = true), TOAST_MS.error);
  showStatus(sentMessage);
  historyLoaded = false;

  // A successful POST to toncenter only means the message was accepted for
  // relay. The wallet's seqno moving is what actually proves it landed.
  const confirmed = await wallet.waitForConfirmation(prepared.seqno);
  showStatus(
    confirmed
      ? 'Confirmed by the network.'
      : 'Broadcast, but not confirmed within a minute — check the explorer before resending.',
    confirmed ? 'success' : 'error',
  );
  await refreshWalletInfo().catch(() => {});
}

sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wallet) return;

  const to = (document.querySelector<HTMLInputElement>('#to-input')!).value.trim();
  const amount = amountInput.value.trim();
  const comment = (document.querySelector<HTMLInputElement>('#comment-input')!).value.trim();
  const jetton = selectedJetton();

  sendBtn.disabled = true;
  resultEl.hidden = true;
  try {
    showStatus('Checking the transaction…');

    if (jetton) {
      const prepared = await wallet.buildAndSignJetton(
        ble,
        { holding: jetton, to, amount, comment: comment || undefined },
        onSignStatus,
        confirmFee,
      );
      sendForm.reset();
      onAssetChange();
      closeSheets();
      await broadcastAndConfirm(
        prepared,
        `Sent ${amount} ${jetton.symbol}. Waiting for the network to confirm…`,
      );
      return;
    }

    const prepared = await wallet.buildAndSign(
      ble,
      { to, amountTon: amount, comment: comment || undefined },
      onSignStatus,
      confirmFee,
    );
    sendForm.reset();
    onAssetChange();
    closeSheets();
    await broadcastAndConfirm(
      prepared,
      prepared.destinationDeployed
        ? 'Sent. Waiting for the network to confirm…'
        : 'Sent to an address with no contract deployed yet — sent non-bounceable so the coins stay there. Waiting for confirmation…',
    );
  } catch (err) {
    if (err instanceof SendCancelledError) {
      showStatus('Cancelled.');
      return;
    }
    console.error('send failed', err);
    showStatus(`Send failed: ${(err as Error)?.message ?? String(err)}`, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

nftForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!wallet || !selectedNft) return;

  const item = selectedNft;
  const to = nftToInput.value.trim();
  const comment = nftCommentInput.value.trim();

  nftSendBtn.disabled = true;
  resultEl.hidden = true;
  try {
    showStatus('Checking the transfer…');
    const prepared = await wallet.buildAndSignNft(
      ble,
      { item, to, comment: comment || undefined },
      onSignStatus,
      confirmFee,
    );
    nftForm.reset();
    nftTransferEl.hidden = true;
    selectedNft = null;
    await broadcastAndConfirm(prepared, `Transferring ${item.name}. Waiting for the network…`);
    await loadNfts();
  } catch (err) {
    if (err instanceof SendCancelledError) {
      showStatus('Cancelled.');
      return;
    }
    console.error('nft transfer failed', err);
    showStatus(`Transfer failed: ${(err as Error)?.message ?? String(err)}`, 'error');
  } finally {
    nftSendBtn.disabled = false;
  }
});

// ------------------------------------------------------------ TON Connect

/** Every session this browser holds, for any wallet; only the ones for the
 * wallet on the connected device are listened to (ownApps). */
let tcApps: ConnectedApp[] = loadApps();
const tcListeners = new Map<string, { close(): void }>();
/** Connects and requests are handled one at a time, in arrival order: one
 * prompt on screen, one thing for the device button to mean. */
let tcQueue: Promise<void> = Promise.resolve();
/** Settles the prompt on screen, if any, as rejected. */
let tcDismissPrompt: (() => void) | null = null;

function tcEnqueue(task: () => Promise<void>) {
  tcQueue = tcQueue.then(task).catch((err) => console.error('[tonconnect]', err));
}

function ownApps(): ConnectedApp[] {
  if (!wallet) return [];
  const address = wallet.address.toRawString();
  const network = wallet.network;
  return tcApps.filter((a) => a.address === address && a.network === network);
}

function persistApps() {
  saveApps(tcApps);
  renderApps();
}

function startListening(app: ConnectedApp) {
  const id = app.keyPair.publicKey;
  if (tcListeners.has(id)) return;
  tcListeners.set(
    id,
    listen(app, (request, eventId) => {
      tcEnqueue(async () => {
        try {
          if (!isNewRequest(app, request.id)) return;
          switchView('dapps');
          await handleAppRequest(app, request);
          markRequestAnswered(app, request.id);
        } finally {
          // Only now: a request still waiting when the page closes is sent
          // again by the bridge next time instead of lost.
          if (eventId) app.lastEventId = eventId;
          saveApps(tcApps);
        }
      });
    }),
  );
}

function startTonConnect() {
  for (const app of ownApps()) startListening(app);
  renderApps();
}

function stopTonConnect() {
  for (const listener of tcListeners.values()) listener.close();
  tcListeners.clear();
  tcDismissPrompt?.();
  tcAppsEl.replaceChildren();
}

function removeApp(app: ConnectedApp) {
  tcListeners.get(app.keyPair.publicKey)?.close();
  tcListeners.delete(app.keyPair.publicKey);
  tcApps = tcApps.filter((a) => a !== app);
  persistApps();
}

function renderApps() {
  const apps = ownApps();
  tcAppsEmpty.hidden = apps.length > 0;
  tcAppsEl.replaceChildren(
    ...apps.map((app) => {
      const row = document.createElement('div');
      row.className = 'asset';
      const icon = document.createElement('span');
      icon.className = 'asset-icon';
      icon.textContent = app.manifest.name.slice(0, 2).toUpperCase();
      const name = document.createElement('span');
      name.className = 'asset-symbol';
      name.textContent = app.manifest.name;
      const domain = document.createElement('span');
      domain.className = 'asset-name';
      domain.textContent = app.manifest.domain;
      const text = document.createElement('span');
      text.className = 'asset-text';
      text.append(name, domain);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = 'Disconnect';
      btn.addEventListener('click', () => {
        removeApp(app);
        sendEvent(app, { event: 'disconnect', id: app.nextEventId++, payload: {} }).catch((err) =>
          console.warn('[tonconnect] could not tell the site about the disconnect', err),
        );
      });
      row.append(icon, text, btn);
      return row;
    }),
  );
}

/** Shows what a site asks for and waits for Approve or Reject. All of it
 * goes in as text: every word of it comes from the site. */
function tcPrompt(title: string, fields: [string, string][], approveLabel: string): Promise<boolean> {
  const result = confirmModal({
    title,
    fields,
    confirmLabel: approveLabel,
    cancelLabel: 'Reject',
    onDismissHandle: (dismiss) => {
      tcDismissPrompt = dismiss;
    },
  });
  return result.finally(() => {
    tcDismissPrompt = null;
  });
}

async function handleConnect(link: ConnectLink) {
  if (!wallet) return;
  const own = wallet;
  showStatus('Loading the site\'s details…');
  const manifest = await fetchManifest(link.request.manifestUrl);
  const app: ConnectedApp = {
    keyPair: new SessionCrypto().stringifyKeypair(),
    clientId: link.clientId,
    manifest,
    network: own.network,
    address: own.address.toRawString(),
    nextEventId: 1,
  };
  const reject = (message: string) =>
    sendEvent(app, { event: 'connect_error', id: app.nextEventId++, payload: { code: ERROR.USER_REJECTS, message } });

  const addrItem = link.request.items.find((i) => i.name === 'ton_addr');
  const wanted = addrItem?.name === 'ton_addr' ? addrItem.network : undefined;
  if (wanted !== undefined && wanted !== (own.network === 'mainnet' ? '-239' : '-3')) {
    await reject(`The wallet is connected to ${own.network}.`);
    showStatus(`${manifest.name} wants the other network. Reconnect the device on it to use this site.`, 'error');
    return;
  }
  const proofItem = link.request.items.find((i) => i.name === 'ton_proof');
  showStatus(`${manifest.name} wants to connect.`);
  const approved = await tcPrompt(
    'CONNECT SITE',
    [
      ['site', manifest.fromLink ? `${manifest.name} (its manifest can't be read here — named from its link)` : manifest.name],
      ['address', manifest.url],
      ['sign in', proofItem ? `yes — the device will show ${manifest.domain}` : 'not asked'],
    ],
    proofItem ? 'Connect & sign in on device' : 'Connect',
  );
  if (!approved) {
    await reject('The user declined.');
    showStatus('Connection declined.');
    return;
  }

  const walletStateInit = beginCell().store(storeStateInit(own.wallet.init)).endCell().toBoc().toString('base64');
  const items: ConnectItemReply[] = [
    {
      name: 'ton_addr',
      address: own.address.toRawString(),
      network: own.network === 'mainnet' ? '-239' : '-3',
      walletStateInit,
      publicKey: own.wallet.publicKey.toString('hex'),
    },
  ];
  if (proofItem?.name === 'ton_proof') {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { domain: manifest.domain, timestamp, payload: proofItem.payload, testnet: own.network === 'testnet' };
    let signature;
    try {
      signature = await ble.signProof(params, (status) => {
        if (status === WalletStatus.ProofAwaitingConfirm) {
          startConfirmCountdown(`Check ${manifest.domain} on the device and hold its button for a second to sign in`);
        }
      });
    } catch (err) {
      await reject('Sign-in was not confirmed on the device.');
      throw err;
    }
    // The device builds this message itself; if what it signed isn't what
    // the site will check, the site would only say "invalid proof".
    if (!signVerify(tonProofHash(own.address, params.domain, timestamp, params.payload), signature, own.wallet.publicKey)) {
      await reject('The device signed something else.');
      throw new Error('The device signed something other than this sign-in. Not sending it.');
    }
    items.push({
      name: 'ton_proof',
      proof: {
        timestamp,
        domain: { lengthBytes: Buffer.byteLength(params.domain), value: params.domain },
        payload: params.payload,
        signature: signature.toString('base64'),
      },
    });
  }

  await sendEvent(app, { event: 'connect', id: app.nextEventId++, payload: { items, device: DEVICE_INFO } });
  tcApps.push(app);
  persistApps();
  startListening(app);
  showStatus(`Connected to ${manifest.name}.`, 'success');
}

async function handleAppRequest(app: ConnectedApp, request: AppRequest<RpcMethod>) {
  if (!wallet || !tcApps.includes(app)) return;
  const own = wallet;
  const name = app.manifest.name;
  const respond = (response: Parameters<typeof sendResponse>[1]) =>
    sendResponse(app, response).catch((err) => console.warn('[tonconnect] could not answer the site', err));

  if (request.method === 'disconnect') {
    removeApp(app);
    await respond({ id: request.id, result: {} });
    showStatus(`${name} disconnected.`);
    return;
  }
  if (request.method !== 'sendTransaction') {
    await respond(errorResponse(request.id, new TonConnectError(ERROR.NOT_SUPPORTED, `${request.method} is not supported.`)));
    return;
  }

  let tx;
  try {
    tx = parseSendTransaction(request.params[0], { address: own.address, network: own.network });
  } catch (err) {
    await respond(errorResponse(request.id, err));
    showStatus(`Refused a request from ${name}: ${(err as Error).message}`, 'error');
    return;
  }

  const fields: [string, string][] = [['site', `${name} (${app.manifest.domain})`]];
  tx.messages.forEach((m, i) => {
    const n = tx.messages.length > 1 ? ` ${i + 1}` : '';
    const transfer = m.body instanceof Cell ? decodeTokenTransfer(m.body) : undefined;
    const recipient = (a: Address) => a.toString({ bounceable: false, testOnly: own.network === 'testnet' });
    if (transfer?.kind === 'jetton') {
      // Addressed to one of this wallet's own jetton wallets; which token
      // that is comes from the holdings already loaded, not from the site.
      const held = jettons.find((j) => j.wallet.equals(m.to));
      fields.push([
        `send${n}`,
        held
          ? `${shortAmount(formatUnits(transfer.amount, held.decimals))} ${held.symbol}${held.verified ? '' : ' (unverified token)'}`
          : `${transfer.amount} units of a token this wallet doesn't hold`,
      ]);
      fields.push([`to${n}`, recipient(transfer.recipient)]);
      if (held && transfer.amount >= held.balance) {
        fields.push([`warning${n}`, `this is your whole ${held.symbol} balance`]);
      }
      fields.push([`gas${n}`, `${shortAmount(fromNano(m.value))} GRAM`]);
    } else if (transfer?.kind === 'nft') {
      const item = nfts.find((nft) => nft.address.equals(m.to));
      fields.push([`send${n}`, item ? `NFT "${item.name}"` : `NFT ${m.to.toString({ testOnly: m.testOnly })}`]);
      fields.push([`to${n}`, recipient(transfer.recipient)]);
      fields.push([`gas${n}`, `${shortAmount(fromNano(m.value))} GRAM`]);
    } else {
      fields.push([`to${n}`, m.to.toString({ bounceable: m.bounce, testOnly: m.testOnly })]);
      fields.push([`amount${n}`, `${shortAmount(fromNano(m.value))} GRAM`]);
      if (m.body) fields.push([`data${n}`, 'contract call — the device shows what it can read of it']);
    }
    if (m.init) fields.push([`deploy${n}`, 'creates a new contract']);
  });
  fields.push(['total', `${shortAmount(fromNano(tx.total))} GRAM + network fees`]);
  showStatus(`${name} asks to send a transaction.`);
  if (!(await tcPrompt('REQUEST', fields, 'Sign on device'))) {
    await respond(errorResponse(request.id, new TonConnectError(ERROR.USER_REJECTS, 'The user declined.')));
    showStatus('Request declined.');
    return;
  }

  try {
    showStatus('Checking the transaction…');
    const prepared = await own.buildAndSignDapp(ble, tx, onSignStatus);
    const boc = await own.broadcast(prepared);
    await respond({ id: request.id, result: boc });
    showStatus(`Sent for ${name}. Waiting for the network to confirm…`);
    own.waitForConfirmation(prepared.seqno).then((confirmed) => {
      if (wallet !== own) return;
      showStatus(
        confirmed
          ? 'Confirmed by the network.'
          : 'Broadcast, but not confirmed within a minute — check the explorer before resending.',
        confirmed ? 'success' : 'error',
      );
      refreshWalletInfo().catch(() => {});
    });
  } catch (err) {
    const declined = /rejected|timed out/i.test((err as Error)?.message ?? '');
    await respond(
      errorResponse(request.id, declined ? new TonConnectError(ERROR.USER_REJECTS, 'Declined on the device.') : err),
    );
    showStatus(`Request from ${name} failed: ${(err as Error)?.message ?? String(err)}`, 'error');
  }
}

tcLinkForm.addEventListener('submit', (e) => {
  e.preventDefault();
  let link: ConnectLink;
  try {
    link = parseConnectLink(tcLinkInput.value);
  } catch (err) {
    showStatus((err as Error).message, 'error');
    return;
  }
  tcLinkInput.value = '';
  tcEnqueue(() =>
    handleConnect(link).catch((err) => showStatus(`Connecting failed: ${(err as Error)?.message ?? String(err)}`, 'error')),
  );
});

disconnectBtn.addEventListener('click', () => {
  // onDisconnected does the actual teardown — this just asks for it.
  ble.disconnect();
});

async function checkForUpdate() {
  fwCheckBtn.disabled = true;
  fwUpdateBtn.hidden = true;
  fwBanner.hidden = true;
  pendingRelease = null;
  try {
    showStatus('Checking for firmware updates…');
    const release = await fetchLatestRelease();
    fwLatestEl.textContent = release.version;
    const deviceVersion = fwVersionEl.textContent ?? '';
    if (updateAvailable(deviceVersion, release)) {
      pendingRelease = release;
      fwUpdateBtn.hidden = false;
      const summary = release.notes
        ? `Firmware ${release.version} is available. ${release.notes}`
        : `Firmware ${release.version} is available.`;
      showStatus(summary, 'success');
      // Repeated at the top of the wallet screen: the firmware block sits
      // below the send form, and an update nobody scrolls to is an update
      // that never gets installed.
      fwBannerText.textContent = summary;
      fwBanner.hidden = false;
    } else {
      showStatus('The device is already up to date.', 'success');
    }
  } catch (err) {
    showStatus(`Update check failed: ${(err as Error).message}`, 'error');
  } finally {
    fwCheckBtn.disabled = false;
  }
}

async function installUpdate() {
  if (!pendingRelease) return;
  fwUpdateBtn.disabled = true;
  fwBannerBtn.disabled = true;
  fwCheckBtn.disabled = true;
  try {
    showStatus('Downloading firmware…');
    const image = await downloadImage(pendingRelease);

    // The PIN was entered on the gate screen for this same connection, so
    // the device's session is already unlocked — no second prompt here.
    expectingReboot = true;
    await ble.updateFirmware(
      image,
      (sent, total) => {
        showStatus(`Installing… ${Math.floor((sent / total) * 100)}%`);
      },
      (status) => {
        if (status === OtaStatus.AwaitingConfirm) {
          showStatus('Press the confirm button on the device to allow the update.');
        }
        if (status === OtaStatus.Preparing) {
          showStatus('Installing… preparing the device.');
        }
        if (status === OtaStatus.AwaitingSwitch) {
          showStatus(`Check the version on the device screen (${pendingRelease?.version}), then press its button to switch to it.`);
        }
      },
    );
    fwBanner.hidden = true;
    showStatus('Update sent. The device is rebooting into it.', 'success');
  } catch (err) {
    expectingReboot = false;
    showStatus(`Update failed: ${(err as Error).message}`, 'error');
  } finally {
    fwUpdateBtn.disabled = false;
    fwBannerBtn.disabled = false;
    fwCheckBtn.disabled = false;
  }
}

fwCheckBtn.addEventListener('click', () => {
  checkForUpdate().catch((err) => showStatus(`Update check failed: ${(err as Error).message}`, 'error'));
});

for (const btn of [fwUpdateBtn, fwBannerBtn]) {
  btn.addEventListener('click', () => {
    installUpdate().catch((err) => showStatus(`Update failed: ${(err as Error).message}`, 'error'));
  });
}

// ------------------------------------------------------- USB provisioning

function humanSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function closeFlashModal() {
  flashModalOverlay.hidden = true;
}

flashModalCancelBtn.addEventListener('click', closeFlashModal);
flashModalOverlay.addEventListener('click', (e) => {
  if (e.target === flashModalOverlay) closeFlashModal();
});

flashBtn.addEventListener('click', async () => {
  flashBtn.disabled = true;
  pendingFlash = null;
  try {
    showStatus('Looking up the current release…');
    const release = await fetchLatestRelease();
    if (!release.flash) {
      throw new Error(
        `Release ${release.version} ships only an over-the-air image, not a full USB install.`,
      );
    }
    // Downloaded before the warning is shown, not after: it's the part that
    // can fail slowly, and the port picker that follows the confirmation
    // has to open in that click's own turn — see flashDevice().
    showStatus('Downloading the firmware…');
    const images = await Promise.all(release.flash.parts.map((part) => downloadBinary(part.url, part.sha256)));
    pendingFlash = { plan: release.flash, images, version: release.version };

    flashModalVersion.textContent = release.version;
    flashModalChip.textContent = release.flash.chip;
    flashModalDevNote.hidden = release.flash.secure;
    flashModalSecureNote.hidden = !release.flash.secure;
    flashModalSize.textContent = humanSize(images.reduce((sum, image) => sum + image.byteLength, 0));
    statusEl.hidden = true;
    flashModalOverlay.hidden = false;
  } catch (err) {
    showStatus(`Firmware install failed: ${(err as Error).message}`, 'error');
  } finally {
    flashBtn.disabled = false;
  }
});

flashModalConfirmBtn.addEventListener('click', () => {
  const job = pendingFlash;
  if (!job) return;
  closeFlashModal();
  // Started, not awaited, straight out of the click handler: the browser's
  // USB port picker only opens while this click still counts as a gesture.
  runFlash(job).catch((err) => showStatus(`Firmware install failed: ${(err as Error).message}`, 'error'));
});

async function runFlash(job: { plan: FlashPlan; images: ArrayBuffer[]; version: string }) {
  flashBtn.disabled = true;
  showStatus('Pick the device in the browser prompt…');
  try {
    const chip = await flashDevice(job.plan, job.images, {
      onStep: (message) => showStatus(message),
      onProgress: (fraction) => showStatus(`Writing… ${Math.floor(fraction * 100)}%`),
    });
    pendingFlash = null;
    // If the app was connected to this device over Bluetooth, erasing it
    // dropped the link and left "The device disconnected" up top. That was
    // the install doing its job, not a fault — don't leave it beside "Done".
    statusEl.hidden = true;
    showStatus(`Done — this ${chip} now runs firmware ${job.version}. It is restarting, which takes a few seconds. When its screen comes up, connect to it with the button above.`,
      'success',
    );
  } catch (err) {
    // What the port picker throws when it's dismissed without a choice.
    const error = err as Error;
    showStatus(error.name === 'NotFoundError'
        ? 'No device was selected. Check the USB cable — some are charge-only — and try again.'
        : `Firmware install failed: ${error.message}`,
      'error',
    );
  } finally {
    flashBtn.disabled = false;
  }
}

if (!manifestConfigured()) {
  flashBtn.disabled = true;
  showStatus('No firmware release feed is configured for this build.');
} else if (!usbFlashingSupported()) {
  flashBtn.disabled = true;
  showStatus('Installing over USB needs desktop Chrome or Edge — this browser cannot open serial ports.',
  );
}

pinChangeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  pinChangeBtn.disabled = true;
  try {
    const status = await ble.changePin(pinChangeInput.value, (s) => {
      if (s === WalletStatus.PinChangeAwaitingConfirm) {
        showStatus('Press the confirm button on the device to change the PIN.');
      }
    });
    pinChangeInput.value = '';
    showStatus(status === WalletStatus.PinChanged
        ? 'PIN changed. It applies from your next connection.'
        : 'The PIN change was rejected or timed out on the device.',
      status === WalletStatus.PinChanged ? 'success' : 'error',
    );
  } catch (err) {
    showStatus(`Changing the PIN failed: ${(err as Error).message}`, 'error');
  } finally {
    pinChangeBtn.disabled = false;
  }
});

wipeBtn.addEventListener('click', async () => {
  // A deliberate extra step: this destroys the key, and the button sits
  // directly under the ordinary device controls.
  const confirmed = await confirmModal({
    title: 'ERASE WALLET',
    message:
      'Erase the wallet and PIN on this device? This cannot be undone here — only the 24-word phrase can recover the funds, and only into another wallet.',
    confirmLabel: 'Erase',
    danger: true,
  });
  if (!confirmed) return;
  wipeBtn.disabled = true;
  try {
    expectingReboot = true;
    const status = await ble.wipeDevice((s) => {
      if (s === WalletStatus.WipeAwaitingConfirm) {
        showStatus('Press the confirm button on the device to erase it.', 'error');
      }
    });
    if (status === WalletStatus.Wiped) {
      showStatus('Erased. The device is rebooting as a fresh device.', 'success');
    } else {
      expectingReboot = false;
      showStatus('The erase was rejected or timed out on the device.', 'info');
    }
  } catch (err) {
    expectingReboot = false;
    showStatus(`Erase failed: ${(err as Error).message}`, 'error');
  } finally {
    wipeBtn.disabled = false;
  }
});
