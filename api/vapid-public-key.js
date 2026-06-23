module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const key = process.env.VAPID_PUBLIC_KEY || "";
  res.json({ key });
};
