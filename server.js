const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('tapok alive'));

app.listen(PORT, () => {
  console.log('server on port ' + PORT);

  // Пингуем себя каждые 3 секунды чтобы не засыпать на Render
  const http = require('http');
  setInterval(() => {
    try {
      http.get('http://localhost:' + PORT + '/', () => {}).on('error', () => {});
    } catch {}
  }, 3000);
});

module.exports = app;
