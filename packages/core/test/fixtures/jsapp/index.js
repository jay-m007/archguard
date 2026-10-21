const helper = require("./lib/helper");
const express = require("express");
async function main() {
  const { lazy } = await import("./lib/lazy.mjs");
  return [helper, express, lazy];
}
module.exports = main;
