# Owner's guide

## The essentials first

- **The 24 words are your money.** The board is only a convenient way to
  sign. Lose the board but keep the phrase, and your funds are safe. Lose
  the phrase and forget the PIN, and the funds are gone for good; nobody
  can help.
- **The device and the app never ask you to type in the 24 words.** The
  phrase is only ever shown on the board's screen. If a website, an app or
  a person asks you to enter the words, it is theft.
- **Trust the board's screen, not the browser.** Before signing, the board
  itself shows how much is going where. If the screen does not show what
  you are sending, do not press the button.
- **Open the app only as https://wallet.quicknet.cc, from a bookmark.** Not
  from links in messages, ads or search results: a copy of the page on
  another address can look exactly the same.
- **Any website can open the Bluetooth window.** Picking the board in it
  lets that site ask for your PIN and for signatures. Connect only from the
  app's own page, and never enter the PIN on any other site.

> **The board locks itself the first time it starts.** Installing the
> firmware burns Secure Boot and Flash Encryption into the chip, and that
> cannot be undone: from then on the board runs only firmware signed by the
> project, and its flash cannot be read over USB. It also means the board
> can no longer be reinstalled over USB — updates come over Bluetooth, from
> the app. Keep the cable plugged in during that first start: it takes up
> to a minute while the flash is encrypted.

## What you need

- Chrome or Edge on a computer, or Chrome on Android.
- **iPhone and Safari will not work**: they have no Web Bluetooth, and no
  setting changes that.
- Paper and a pen for the 24 words. Do not photograph the phrase and do not
  keep it in notes, cloud storage or a messenger.

The board has two small buttons beside the USB-C port. One is **BOOT**,
which is only used when installing firmware over USB; the other is the
confirm button, and it is the one every "press the button" below means.
While the wallet is running BOOT does nothing at all, so if a press has no
effect on the screen, it was the wrong button.

## First connection

1. Open the app and press **Connect to device**.
2. The board's screen shows a **Pairing Code**, six digits. Enter it on the
   computer or phone when the system asks for it.
   The code protects against a device being impersonated over the air: if
   the system did not ask for a code and the screen did not show one,
   disconnect and do not continue.
3. On a new board, **set the PIN** first (see [PIN](#pin)) and press the
   button on the board to store it. The wallet key is encrypted under this
   PIN the moment it is created, so the PIN comes before the wallet.

## Creating the wallet

1. **Create new wallet**, then press the button on the board (you have 30
   seconds).
2. **Generating key... please wait** usually takes 10–20 seconds, now and
   then over a minute; that is normal.
3. **View backup phrase now**: the board shows all 24 words on one screen
   in two columns (1–12 down the left, 13–24 down the right). Write down
   each number and word, double-check every one, then press the button.
4. After that the board asks for three words by number, one at a
   time, and offers five words for each. Look up the answer in what you
   wrote down: a short press moves to the next word, holding the button for
   a second picks the highlighted one. A wrong pick ends the check; view the
   phrase again and correct your copy. The app will not let you continue
   until the check passes.
5. **Continue to the wallet**.

The board checks only three of the 24 words. To check the whole phrase
**before you put money on the wallet**, restore the wallet in Tonkeeper on another
device from the 24 words and compare the address with the one in the app.
If they match, the phrase is written down correctly. You do not need to
send anything. Afterwards, remove the wallet from Tonkeeper if you are not
going to use it there.

You can show the phrase again at any time: **Recovery phrase** in the More tab of
the wallet, confirmed with the button on the board. Only do it when nobody can
see the screen.

## PIN

- 6 to 10 characters. It is asked on every connection; the board locks
  again whenever it disconnects, and after 5 minutes without any operation
  (**Locked** on its screen; the app asks for the PIN again).
- The PIN is not stored on the board and is not just checked against a
  list: the wallet key is kept encrypted under it, and only the right PIN
  decrypts it. The encryption also runs through a key built into the chip
  that nothing can read out, so even a copy of the board's memory can't be
  tried against PINs anywhere but on the board itself — with its waits.
  Letters work too; a longer PIN is a stronger one.
- **Setting the first PIN needs a button press on the board**, like changing
  it. Until a PIN exists there is nothing else that tells the board the
  request comes from you: whoever gets a PIN onto a board that has none can
  keep its owner from ever signing or erasing it, and only the button proves
  someone is standing in front of it.
- Three wrong attempts in a row carry no penalty. After that, each further
  mistake doubles the wait before the next attempt (seconds, then minutes,
  up to one hour). Rebooting the board does not reset the wait.
- **Change PIN** requires the current PIN and a button press.

### If you forget the PIN

It cannot be recovered, and the board cannot be erased from the app
without it either; that is by design. The funds are reachable only through
the 24 words: restore the wallet in Tonkeeper (see below) and move the
funds.

The board cannot be reinstalled over USB either (see the note at the top),
so a board whose PIN is forgotten cannot be used again. The funds are not
lost with it — the 24 words are all you need.

## Receiving

**Receive** shows the wallet's address. Before you hand it to anyone (an
exchange above all), press **Check on device**: the board works the address
out from its own key and shows it in full under **Your address**. Compare
every character with the one in the app, then press the button. If they
differ, do not use the address — the page or the "board" you are connected
to is not genuine.

## Sending

1. Fill in the form, press **Sign & Send** and confirm the fee.
2. The board shows a page for the request as a whole, then one or more pages
   per outgoing message:
   - **Signing request** — when the transaction stops being valid, in UTC, and
     how many messages it carries. The board has no clock, so it can only show
     this deadline, not check it: compare it with the clock on your phone. A
     few minutes from now is what the app asks for; a date far in the future
     means whoever built the transaction could hold on to your signature and
     use it later;
   - **Send GRAM** — the amount and the **full** recipient address over
     two lines. Compare the whole address, not just the start and end:
     scammers generate addresses with matching ends;
   - the comment, if any; a long one gets its own page. When sending to an
     exchange, check the memo;
   - **Token wallet** — which of your token balances the transfer comes
     out of, as the full address of that token's wallet. The board reads it
     out of what it is signing, but for most tokens it cannot tell which
     token lives there, so this page is what the app's claim about the token
     can be checked against. USD₮ is the exception: the board works out your
     USD₮ wallet itself and titles this page **Your USDT wallet**;
   - **NFT item** — the full address of the item being handed over, on a page
     of its own. Nothing else on the screen says which item is leaving, so
     compare this whole address, the same way as a recipient's;
   - **Send token** — the token amount, the recipient and the GRAM spent on
     fees. The recipient and the number of token units come from what is
     being signed. For USD₮ the board names the token and places the
     decimal point itself — **USDT**, without a `?` — and refuses a request
     where the app says otherwise. For any other token the `?` next to its
     name covers both the name and **where the decimal point goes**: that
     figure is the app's word, so a token you do not recognise deserves a
     small test transfer first;
   - **Send NFT** — the new owner; the item itself was on the page before;
   - `+deploy` — a contract is created along with the transfer. A normal
     transfer should not have this;
   - `!Call` — a contract call the board cannot decode. A swap from GRAM
     looks like this. In any other case, do not sign;
   - `TESTNET` on the bottom line — the test network, not real money.
3. A press turns the pages. On the last page a press does nothing: to sign,
   **hold the button for a second** (**Hold 1s = sign**), so quick presses
   in a row can never run through the pages into a signature. Each page has 30 seconds, after which the request is
   refused.

**Transaction / Not understood, refused** — the board refused to sign what
it was sent. That is protection, not a fault.

**Busy** — another operation is already waiting for confirmation; finish it
or wait for it to be cancelled.

## Swaps

Swaps work only on mainnet. The board shows a swap from GRAM as `!Call` to a
pool address, and a swap from a token as **Send token** with a `?`. The app
checks that a swap cannot take more than the amount you entered, but where
the swapped amount actually goes cannot be verified. Only swap amounts you
can afford to lose.

## Connecting to sites (TON Connect)

Sites such as exchanges, games or NFT markets connect to the wallet through
TON Connect. This wallet is not in the sites' list of wallets, so you connect
it by link:

1. Connect the board and unlock it with the PIN, then open the **Apps** tab.
   Keep the tab open while you use the site: requests only arrive while the
   app is open and the board is connected.
2. On the site, press **Connect wallet**, pick any wallet in the list and
   press **Copy link** under the QR code. Which wallet you pick does not
   matter.
3. Paste the link into **link** and press **Connect**. The app shows the
   site's name and address; check them and press **Connect**.
4. Many sites also ask you to sign in. The board then shows **Sign in to
   site:**, the site's domain in full, and the time in UTC. Compare the
   domain letter by letter with the one in your browser's address bar: a
   look-alike domain is how phishing sites get your sign-in. If it matches,
   hold the button for a second. **Sign In / Not understood, refused** means the domain
   contains characters the board cannot show faithfully, so it will not
   sign for it.

When the site asks for a transaction, the app switches to the **Apps** tab
and lists every message: the recipient, the amount, whether it carries
contract data or creates a contract. **Sign on device** sends it to the
board, which shows it the same way as your own transfers (see Sending).
What a site sends is usually a contract call and appears as `!Call`: the
board can check the amount and the recipient contract, but not what that
contract will do. Sign only on sites you trust, and only amounts you can
afford to lose. **Reject** tells the site you declined.

Connected sites stay in the **CONNECTED SITES** list, even after you close
the app. **Disconnect** ends the session on both sides.

Limits:

- at most 4 messages in one request;
- the site and the app must be on the same network: to use a testnet site,
  connect the board on testnet;
- a signature the app asks for is valid for at most 5 minutes;
- signing arbitrary data (`signData`) is not supported: sites that need it
  get a refusal.

## If the screen says "Re-pair Attempt"

Someone is trying to pair with the board again. Press the button **only if
it is you** re-pairing your own phone or computer. Otherwise, press
nothing: the request expires on its own.

## Firmware updates

When a new version is out, the app shows an **Install it** banner. The
board shows **OTA Update / Press button / to confirm**. Once the new version
has been received and checked, the board shows **Install firmware?** with the
new and the current version: press the button again to switch to it. A
version older than the one installed is refused (**Older version,
refused**).

Two checks stand between you and someone else's firmware. The app installs
only releases signed with the project's key, and the board itself starts
only firmware signed with the project's Secure Boot key — anything else it
refuses to boot. Still:

- update only from the app opened from a site you trust;
- ignore pages offering "new firmware" for the board: nothing but the app
  can update it.

There is no going back to an older version once an update has fixed a
security problem: the board refuses older firmware from then on.

## Losing or breaking the board

1. Install Tonkeeper (or another TON wallet that supports W5).
2. Choose to restore from 24 words. There is no need to switch the wallet
   version: the address will match the one the app showed.
3. Move the funds wherever you will keep them from now on.

The phrase cannot be entered back into the board: it can only create a new
wallet.

The address differs between testnet and mainnet; that is normal, the key is
the same. If the wallet was created before the switch to W5, older funds
remain on the V4 address: Tonkeeper shows them when you explicitly choose
version V4.

## Erasing the board

**Erase wallet** (More tab) — requires the PIN, then the screen shows
**ERASE WALLET?** and you confirm with the button. Everything is erased: the
key, the phrase, the PIN, and the pairings — every phone and computer paired
with the board has to pair again, by the code on the screen. Before doing
this, make sure the phrase is written down and checked, or that the wallet is
empty.

## What others can see

- The board constantly announces itself over Bluetooth as
  `QuickWallet`: anyone nearby with a phone can tell that you have a
  crypto wallet.
- The toncenter service sees your wallet address when the app requests the
  balance, tokens and NFTs.
- A site you connect to learns your wallet address. The TON Connect bridge
  (`bridge.tonapi.io`) that carries messages between the site and the app
  sees that the two are talking, but not what they say: the messages are
  encrypted end to end.
