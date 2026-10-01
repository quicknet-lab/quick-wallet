<img src="logo.svg" width="72" height="72" alt="">

# Quick Wallet

A hardware wallet for TON on a small board with a screen and a button. The
private key is generated on the board and never leaves it. Every transfer is
shown on the board's own screen and signed only when you press its button.
You use it from a web page in the browser over Bluetooth — there is no app to
install.

**Open the wallet: https://wallet.quicknet.cc**

## How it keeps your funds safe

- **The key stays on the board.** The 24-word recovery phrase is created on
  the board and only ever shown on its screen. It never travels to the
  computer or phone, in either direction.
- **You confirm on the device, not in the browser.** The board reads the
  transfer itself and shows the amount, the full recipient address and the
  comment. It signs only when you press its button on the last page. Even a
  compromised computer cannot make it sign something you did not see.
- **The PIN protects the key.** The wallet is stored encrypted under your PIN
  and a hardware key inside the chip that nothing can read out. A PIN can be
  tried only on the board itself, with a growing delay after wrong attempts
  that survives a restart.
- **The board is locked.** On its first start the firmware switches on
  Secure Boot and Flash Encryption for good: the board runs only firmware
  signed by the project, and its memory cannot be read over USB. Updates are
  signed too, and the app checks every one before it is installed.
- **Pairing is protected.** Bluetooth pairing uses a six-digit code shown on
  the board's screen.

## What it can do

- Send and receive GRAM, jettons (tokens) and NFTs.
- Swap tokens through STON.fi.
- Connect to TON sites through TON Connect: sign-in shows the site's domain on
  the board, and its transfers are checked on the board like any other.
- Install its firmware over USB straight from the browser, and update over
  Bluetooth.
- The same 24 words restore the wallet, with the same address, in Tonkeeper
  (W5 wallet) — if the board is ever lost.

## What you need

- A **LilyGO T-Display-S3** board (ESP32-S3, 1.9" screen) and a USB-C cable.
  No other board is supported.
- **Chrome or Edge** on a computer, or **Chrome on Android**.
- **iPhone and Safari do not work**: they have no Web Bluetooth.
- Paper and a pen for the 24 words.

## Getting started

1. Open https://wallet.quicknet.cc in Chrome, connect the board by USB and
   press **Install firmware over USB**, then confirm. The first start locks
   the board and takes up to a minute — keep the cable plugged in until the
   screen lights up.
2. Press **Connect to device** and enter the pairing code shown on the board.
3. Set a PIN, then create the wallet and confirm on the board.
4. Write down the 24 words shown on the board and answer the check questions.

The full guide — sending, swaps, sites, updates, what to do if you lose the
board or forget the PIN — is in **[OWNER_GUIDE.md](OWNER_GUIDE.md)**.

## License

Copyright 2026 QuickNet. Licensed under the [MIT License](LICENSE). The
license does not cover the "Quick Wallet" and "QuickNet" names: a modified
build must not be presented as Quick Wallet.

Third-party code and fonts:

- `firmware/components/ed25519` — orlp/ed25519, zlib
  (`firmware/components/ed25519/LICENSE`);
- the screen font — X11 misc-fixed 8x13, public domain, provenance in
  `firmware/main/display_font.h`;
- JetBrains Mono in the web app — SIL Open Font License 1.1
  (`@fontsource/jetbrains-mono`).
