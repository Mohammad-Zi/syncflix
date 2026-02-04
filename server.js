const express = require('express');
const path = require('path');
const app = express();

// Serve files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Always send index.html for any route (optional, for SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Use the port Render provides
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
