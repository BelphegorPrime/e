/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// The UI is part of the CLI package (it ships inside the `e` binary, served by
// `e serve` from dist/ui). Webpack writes straight into the directory the
// runtime reads (src/serve/assets.ts) and pkg embeds (pkg.assets); no copy
// step.
module.exports = {
  context: __dirname,
  entry: './src/index.tsx',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader', 'postcss-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  output: {
    path: path.resolve(__dirname, '..', 'dist', 'ui'),
    filename: 'assets/[name].js',
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: 'e -',
      template: './src/index.html',
    }),
  ],
};
