const path = require('path');

module.exports = {
  entry: './dist/index.js',
  output: {
    filename: 'bundle.js',
    path: path.resolve(__dirname, 'dist'),
    libraryTarget: 'commonjs2'
  },
  resolve: {
    extensions: ['.js']
  },
  mode: 'production',
  target: 'node'
};
