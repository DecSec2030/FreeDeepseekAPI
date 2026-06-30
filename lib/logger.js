const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'server.log');
const MAX_LOG_SIZE = 100 * 1024;
const MAX_LOG_FILES = 3;
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
const LOG_FORMAT = process.env.LOG_FORMAT || 'text';

function rotateLogs() {
  for (let i = MAX_LOG_FILES - 1; i > 0; i--) {
    const oldPath = LOG_FILE + '.' + i;
    const newPath = LOG_FILE + '.' + (i + 1);
    try { if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath); } catch (e) {}
  }
  try { if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch (e) {}
}

function logLevelNum(level) {
  const levels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
  return levels[level] !== undefined ? levels[level] : 1;
}

function writeLog(level, args) {
  if (logLevelNum(level) < logLevelNum(LOG_LEVEL)) return;
  const time = new Date().toISOString();
  const text = args.map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
  if (LOG_FORMAT === 'json') {
    process.stdout.write(JSON.stringify({ time, level, msg: text }) + '\n');
  } else {
    process.stdout.write('[' + time + '] [' + level + '] ' + text + '\n');
  }
  try {
    var stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) rotateLogs();
  } catch (e) {}
  try { fs.appendFileSync(LOG_FILE, '[' + time + '] [' + level + '] ' + text + '\n'); } catch (e) {}
}

const logger = {
  info: function() { writeLog('INFO', Array.prototype.slice.call(arguments)); },
  error: function() { writeLog('ERROR', Array.prototype.slice.call(arguments)); },
  warn: function() { writeLog('WARN', Array.prototype.slice.call(arguments)); },
  debug: function() { writeLog('DEBUG', Array.prototype.slice.call(arguments)); },
};

module.exports = { logger, writeLog, LOG_LEVEL, LOG_FORMAT };
