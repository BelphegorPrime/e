/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/index.tsx',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: 'ts-loader',
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  output: {
    path: path.resolve(__dirname, 'dist/ui'),
    filename: 'assets/[name].js',
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      title: 'e',
      template: './src/index.html',
    }),
  ],
};
