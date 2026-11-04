export function formatWhen(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `今天 ${hm}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${hm}`;
}

export function countLabel(n: number, unit: string) {
  return n > 0 ? `${n} ${unit}` : "空";
}
