// One JSON line per operation. Shows who did what, to which tenant, and when.
export function audit(action, detail = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), audit: action, ...detail }));
}
