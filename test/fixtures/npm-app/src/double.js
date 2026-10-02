const isNumber = require('is-number');
module.exports = (x) => (isNumber(x) ? Number(x) * 2 : null);
