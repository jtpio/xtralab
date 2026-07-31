// Where the suite seeds its demo workspace. Outside the repository because
// captured terminal output bakes in the absolute path, and a home-relative
// location reads the same on every machine and checkout.
const os = require('node:os');
const path = require('node:path');

module.exports = path.join(os.homedir(), '.cache', 'xtralab-screenshots');
