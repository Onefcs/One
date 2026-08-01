// ─────────────────────────────────────────────────────────
//  TON CONNECT — wallet connect + on-chain deposit
// ─────────────────────────────────────────────────────────
// Scope, deliberately: connect/disconnect a real TON wallet (Tonkeeper etc.
// via js/vendor/tonconnect-ui.min.js), auto-fill the withdrawal address from
// it, and let a deposit be sent as an actual on-chain transfer straight from
// the connected wallet instead of the player copy-pasting the address+memo
// into their own wallet app by hand. Everything downstream is unchanged —
// admin still approves the deposit from the GramTx record exactly as before
// (js/network.js's gramDepositRequest / server's notifyAdminGram), this only
// makes *sending* the transfer easier.

let _tonConnectUI = null;
let _tonConnectedAddress = null;

function _tcInit() {
  if (_tonConnectUI || typeof TON_CONNECT_UI === 'undefined') return;
  _tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
    manifestUrl: window.location.origin + '/tonconnect-manifest.json',
  });
  _tonConnectUI.onStatusChange(wallet => {
    _tonConnectedAddress = wallet ? wallet.account.address : null;
    if (typeof _onTonConnectChange === 'function') _onTonConnectChange();
  });
}

function tcConnect() {
  _tcInit();
  if (_tonConnectUI) _tonConnectUI.openModal();
}

function tcDisconnect() {
  if (_tonConnectUI) _tonConnectUI.disconnect();
}

function tcAddress() { return _tonConnectedAddress; }

// ── Minimal single-cell BOC encoder for a TON "text comment" payload ─────
// Every wallet attaches a comment to a simple transfer the same way: one
// cell, no references, holding a 32-bit zero prefix (marks it as plain text,
// not a smart-contract call) followed by the UTF-8 comment bytes. Built by
// hand here rather than pulling in @ton/core, which ships no browser bundle
// this project's plain <script>-tag setup (no bundler) could consume.
// Verified byte-for-byte against @ton/core's own beginCell()...toBoc() output
// across several inputs before wiring this in.
function _crc32c(bytes) {
  const POLY = 0x82f63b78; // reflected Castagnoli polynomial
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (POLY & mask);
    }
  }
  return (~crc) >>> 0;
}

function _commentCellBoc(text) {
  const textBytes = new TextEncoder().encode(text || '');
  const dataBytes = new Uint8Array(4 + textBytes.length);
  dataBytes.set(textBytes, 4); // leading 4 bytes stay 0 — the plain-comment op-code
  if (dataBytes.length > 127) throw new Error('Комментарий слишком длинный');

  const d1 = 0; // 0 refs, not exotic, level 0
  const d2 = dataBytes.length * 2; // byte-aligned data — standard d2 encoding

  const cellPart = new Uint8Array(2 + dataBytes.length);
  cellPart[0] = d1;
  cellPart[1] = d2;
  cellPart.set(dataBytes, 2);

  const header = new Uint8Array([
    0xb5, 0xee, 0x9c, 0x72, // BOC magic
    0x40 | 0x01,            // has_crc32c=1, size_bytes=1
    0x01,                   // off_bytes=1
    0x01,                   // cell count = 1
    0x01,                   // root count = 1
    0x00,                   // absent count = 0
    cellPart.length,        // total cells size (fits one byte for our tiny payload)
    0x00,                   // root list: root cell index 0
  ]);

  const body = new Uint8Array(header.length + cellPart.length);
  body.set(header, 0);
  body.set(cellPart, header.length);

  const crc = _crc32c(body);
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  out[body.length]     = crc & 0xff;
  out[body.length + 1] = (crc >>> 8) & 0xff;
  out[body.length + 2] = (crc >>> 16) & 0xff;
  out[body.length + 3] = (crc >>> 24) & 0xff;
  return out;
}

function _bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Sends amountTon (GRAM==TON 1:1 in this game) from the connected wallet to
// the game's deposit address, with `memo` as the on-chain comment — the same
// MEMO the manual flow has the player type in themselves. Resolves once the
// wallet confirms the user approved it; the deposit still only credits the
// balance once the admin approves the matching GramTx, same as the manual
// flow (see js/network.js gramDepositRequest / gramTxCreated).
async function tcSendDeposit(walletAddress, amountTon, memo) {
  if (!_tonConnectUI || !_tonConnectedAddress) throw new Error('Кошелёк не подключен');
  const nanotons = Math.round(amountTon * 1e9).toString();
  const payload = _bytesToBase64(_commentCellBoc(String(memo)));
  return _tonConnectUI.sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [{ address: walletAddress, amount: nanotons, payload }],
  });
}
