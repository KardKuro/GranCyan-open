// ============================================================
// 画板的第一批画（两张示例动画）。
// 只在画板**从没存过**的时候挂上去一次；用户删了就是删了，不会再冒回来。
// ============================================================
const GALLERY_SEED = [
 {
  "id": "seed-1",
  "kind": "html",
  "author": "GranCyan",
  "caption": "示例画：一片会闪的星空，偶尔有流星划过。删掉就不会再出现。",
  "ts": 1790174400000,
  "src": "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>星空</title>\n<style>html,body{margin:0;height:100%;background:#0b1020;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head><body>\n<canvas id=\"c\" role=\"img\" aria-label=\"夜空里慢慢闪烁的星星，偶尔划过一颗流星\"></canvas>\n<script>\nconst c=document.getElementById('c'),x=c.getContext('2d');let W,H,S=[],m=null;\nfunction fit(){W=c.width=innerWidth*devicePixelRatio;H=c.height=innerHeight*devicePixelRatio;S=Array.from({length:140},()=>({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.6+.3,p:Math.random()*6.28}))}\naddEventListener('resize',fit);fit();\nfunction draw(t){x.fillStyle='#0b1020';x.fillRect(0,0,W,H);\nfor(const s of S){const a=.35+.65*(.5+.5*Math.sin(t/900+s.p));x.globalAlpha=a;x.fillStyle='#dfe8ff';x.beginPath();x.arc(s.x,s.y,s.r*devicePixelRatio,0,6.28);x.fill()}\nx.globalAlpha=1;if(!m&&Math.random()<.004)m={x:Math.random()*W,y:Math.random()*H*.4,l:0};\nif(m){x.strokeStyle='rgba(255,255,255,.8)';x.lineWidth=2;x.beginPath();x.moveTo(m.x,m.y);x.lineTo(m.x-m.l,m.y+m.l*.45);x.stroke();m.x+=9;m.y+=4;m.l=Math.min(m.l+6,120);if(m.x>W+200)m=null}\nrequestAnimationFrame(draw)}\nif(matchMedia('(prefers-reduced-motion: reduce)').matches)draw(0);else requestAnimationFrame(draw);\n</script></body></html>"
 },
 {
  "id": "seed-2",
  "kind": "html",
  "author": "GranCyan",
  "caption": "示例画：月亮和慢慢飘过的云。",
  "ts": 1790175900000,
  "src": "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>月亮和云</title>\n<style>html,body{margin:0;height:100%;background:#141a2e;overflow:hidden}canvas{display:block;width:100%;height:100%}</style></head><body>\n<canvas id=\"c\" role=\"img\" aria-label=\"一轮月亮挂在夜空，几朵云从它前面慢慢飘过\"></canvas>\n<script>\nconst c=document.getElementById('c'),x=c.getContext('2d');let W,H;\nfunction fit(){W=c.width=innerWidth*devicePixelRatio;H=c.height=innerHeight*devicePixelRatio}addEventListener('resize',fit);fit();\nconst clouds=[0,1,2].map(i=>({y:.25+i*.18,s:.15+i*.08,o:i*.33}));\nfunction cloud(cx,cy,k){x.beginPath();for(const[dx,dy,r]of[[0,0,1],[.9,-.3,.8],[1.7,0,.9],[.8,.25,.85]])x.arc(cx+dx*40*k,cy+dy*40*k,r*34*k,0,6.28);x.fill()}\nfunction draw(t){x.fillStyle='#141a2e';x.fillRect(0,0,W,H);const k=Math.min(W,H)/400;\nx.fillStyle='#f6f1d5';x.beginPath();x.arc(W*.62,H*.38,70*k,0,6.28);x.fill();\nx.fillStyle='rgba(0,0,0,.08)';for(const[a,b,r]of[[-.25,-.2,.18],[.2,.1,.13],[-.05,.3,.1]]){x.beginPath();x.arc(W*.62+a*140*k,H*.38+b*140*k,r*70*k,0,6.28);x.fill()}\nx.fillStyle='rgba(200,210,235,.55)';for(const c0 of clouds){const px=((t/1000*c0.s*60+c0.o*W)%(W+300*k))-150*k;cloud(px,H*c0.y,k)}\nrequestAnimationFrame(draw)}\nif(matchMedia('(prefers-reduced-motion: reduce)').matches)draw(0);else requestAnimationFrame(draw);\n</script></body></html>"
 }
];
