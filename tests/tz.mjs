// Preload for the node tests: `node --import ./tests/tz.mjs --test
// tests/*.test.mjs`. The days are calendar days in the owner's zone, and
// Helsinki has DST. Set here, before any module builds a date formatter;
// a line in a test file runs after its imports, too late.
process.env.TZ = "Europe/Helsinki";
