/// <reference types="vite/client" />
// Google Drive for the web version, the lightweight way: Google Identity Services hands the page
// short-lived (~1 h) access tokens and we call Drive REST v3 with fetch. No backend, no secret.
// The price: one click on ☁ per tab, and a ~1 s popup flash when a click renews the token.
// ponytail: popup renewals; a Netlify function holding a refresh token makes them silent if that grates.
// Scope drive.file: the app only ever sees files it created itself.

export const FOLDER = 'draw_board_files', SYNC = 'board.svg';
export type DriveFile = { id: string; name: string; modifiedTime: string; version: string };

/** What to do with the synced board on connect/focus. Last write wins; the caller makes a pull undoable. */
export function syncAction(remote: DriveFile | undefined, seenVersion: string, unpushed: boolean, localChanged: number): 'push' | 'pull' | 'none' {
  if (!remote) return 'push';
  if (remote.version === seenVersion) return unpushed ? 'push' : 'none';
  // ponytail: compares two devices' clocks; fine for one person, server-side versions if it isn't
  if (!seenVersion || unpushed) return Date.parse(remote.modifiedTime) > localChanged ? 'pull' : 'push';
  return 'pull';
}

/** multipart/related body: file metadata + SVG content in one upload. */
export function multipart(meta: object, text: string, boundary: string) {
  return `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
    + `--${boundary}\r\nContent-Type: image/svg+xml\r\n\r\n${text}\r\n--${boundary}--`;
}
