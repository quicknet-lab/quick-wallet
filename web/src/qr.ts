import qrcode from 'qrcode-generator';

/**
 * The address as a QR code, drawn as an inline SVG: black modules on a white
 * square with its quiet zone, whatever the page theme, so any camera reads it.
 * Only the wallet's own address goes in; the text beside it is what the
 * device is checked against.
 */
export function addressQrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ scalable: true, margin: 4 });
}
