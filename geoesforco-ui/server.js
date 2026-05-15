
require('dotenv').config()
const express = require('express');
const path    = require('path');
const routes  = require('./src/routes');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', routes);

app.listen(PORT, () => {
  console.log(`GeoEsforço UI rodando em http://localhost:${PORT}`);
});
