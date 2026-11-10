// What the server says of its backups (GET /backups): when they need
// looking at.

// Below this share of the database disk free, it is low.
const LOW_DISK = 0.1;

// The share of the database disk free, when below LOW_DISK.
export const lowDisk = ({ free_bytes, total_bytes }) =>
  total_bytes && free_bytes / total_bytes < LOW_DISK
    ? free_bytes / total_bytes
    : null;

// No copy in 48 hours (the server's `stale`), or the disk nearly full.
export const backupTrouble = (backups) =>
  Boolean(backups?.configured) && (backups.stale || lowDisk(backups) !== null);
