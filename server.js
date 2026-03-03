const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('tapok alive'));
app.listen(PORT, () => console.log('server on port ' + PORT));
module.exports = app;
