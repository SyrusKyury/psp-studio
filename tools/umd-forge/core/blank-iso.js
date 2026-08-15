const SECTOR = 2048;
const encoder = new TextEncoder();
function both16(view, off, n) { view.setUint16(off,n,true); view.setUint16(off+2,n,false); }
function both32(view, off, n) { view.setUint32(off,n,true); view.setUint32(off+4,n,false); }
function text(bytes, off, len, value) { bytes.fill(0x20, off, off+len); bytes.set(encoder.encode(String(value).slice(0,len)), off); }
function rootRecord(lba = 20) {
  const b = new Uint8Array(34), v = new DataView(b.buffer); b[0]=34; both32(v,2,lba); both32(v,10,SECTOR);
  const now=new Date(); b.set([Math.max(0,now.getUTCFullYear()-1900),now.getUTCMonth()+1,now.getUTCDate(),now.getUTCHours(),now.getUTCMinutes(),now.getUTCSeconds(),0],18);
  b[25]=2; both16(v,28,1); b[32]=1; b[33]=0; return b;
}
export function createBlankIso({ volumeId = 'PSP_GAME' } = {}) {
  const sectors = 21, out = new Uint8Array(sectors * SECTOR), pvd = out.subarray(16*SECTOR,17*SECTOR), pv = new DataView(pvd.buffer,pvd.byteOffset,pvd.byteLength);
  pvd[0]=1; pvd.set(encoder.encode('CD001'),1); pvd[6]=1; text(pvd,8,32,'PLAYSTATION'); text(pvd,40,32,volumeId); both32(pv,80,sectors); both16(pv,120,1); both16(pv,124,1); both16(pv,128,SECTOR); both32(pv,132,10); pv.setUint32(140,18,true); pv.setUint32(148,19,false); pvd.set(rootRecord(20),156); text(pvd,574,128,'UMD FORGE');
  const term=out.subarray(17*SECTOR,18*SECTOR); term[0]=255; term.set(encoder.encode('CD001'),1); term[6]=1;
  const l=out.subarray(18*SECTOR,19*SECTOR), lv=new DataView(l.buffer,l.byteOffset,l.byteLength); l[0]=1; lv.setUint32(2,20,true); lv.setUint16(6,1,true); l[8]=0;
  const m=out.subarray(19*SECTOR,20*SECTOR), mv=new DataView(m.buffer,m.byteOffset,m.byteLength); m[0]=1; mv.setUint32(2,20,false); mv.setUint16(6,1,false); m[8]=0;
  const root=out.subarray(20*SECTOR,21*SECTOR); root.set(rootRecord(20),0); const parent=rootRecord(20); parent[33]=1; root.set(parent,34);
  return new File([out], `${String(volumeId || 'new-umd').replace(/[^a-z0-9_-]+/gi,'_')}.iso`, { type:'application/x-iso9660-image' });
}
