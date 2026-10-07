# The JSON-only updater, byte for byte

`server/link/update.ts` and `server/link/service.ts` here are the files of commit 3ac344e (unchanged since 1.114.1,
226ae49): the update helper every Tower before the SQLite preparation releases runs. The tests check their sha256
before they use them. The other files are re-export shims so the copies resolve their imports to this checkout's
unchanged modules; nothing in the two copies is edited.
