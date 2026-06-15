export default async function handler(req, res) {
  res.json({ hasKey: !!process.env.LTA_API_KEY });
}
