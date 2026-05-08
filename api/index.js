const { handleRequest } = require("../index");

export default async function handler(req, res) {
  await handleRequest(req, res);
}
