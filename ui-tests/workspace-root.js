// Where the suite seeds its demo workspace. It lives outside the repository
// because captured terminal output bakes in the absolute path (the hero's
// Claude Code session prints its working directory), and a home-relative
// location reads the same on every machine and checkout.
const os = require('node:os');
const path = require('node:path');

module.exports = path.join(os.homedir(), '.cache', 'xtralab-screenshots');
