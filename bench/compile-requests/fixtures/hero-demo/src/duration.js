'use strict';

/** Formats a duration in milliseconds for the status line, e.g. 90000 -> "1m 30s". */
function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

module.exports = { formatDuration };
