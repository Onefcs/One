// ─────────────────────────────────────────────────────────
//  LOCATION THEMES  (3 floors each, 7 themes for 20 floors)
// ─────────────────────────────────────────────────────────
const THEMES = [

  // ── 0: Лес (этажи 1-3) ──────────────────────────────
  {
    name:'🌲 Лес', bg:'#020a02', mmFloor:'#1e4010',
    drawWall(c, px, py, fc) {
      const h = ((px/TILE|0)*13 ^ (py/TILE|0)*7) & 0xff;
      c.fillStyle='#0a1205'; c.fillRect(px,py,TILE,TILE);
      const tw=7+(h%3), tx2=px+15+(h%5)-2;
      c.fillStyle='#2c1608'; c.fillRect(tx2,py+6,tw,TILE-6);
      c.fillStyle='#3c2010'; c.fillRect(tx2+1,py+8,2,TILE-12);
      c.fillStyle='#1e0e04'; c.fillRect(tx2+tw-3,py+8,2,TILE-12);
      c.fillStyle='#1a0c04';
      for(let i=0;i<4;i++) c.fillRect(tx2+1,py+12+i*7,tw-2,1);
      c.fillStyle='#241408';
      c.fillRect(tx2-4,py+TILE-10,4,5); c.fillRect(tx2+tw,py+TILE-10,4,5);
      c.fillRect(tx2-2,py+TILE-6,2,6);  c.fillRect(tx2+tw,py+TILE-6,2,6);
      c.fillStyle='#0d2e08';
      c.beginPath(); c.ellipse(px+20,py+20,16,12,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+12,py+26,12,9,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+28,py+24,11,9,0,0,Math.PI*2); c.fill();
      c.fillStyle='#164a0c';
      c.beginPath(); c.ellipse(px+20,py+15,14,11,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+11,py+22,11,9,0.1,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+29,py+20,11,9,-0.1,0,Math.PI*2); c.fill();
      c.fillStyle='#1e6410';
      c.beginPath(); c.ellipse(px+20,py+10,11,9,0,0,Math.PI*2); c.fill();
      c.fillStyle='rgba(80,200,30,0.14)';
      c.beginPath(); c.arc(px+15,py+13,4,0,Math.PI*2); c.fill();
      c.beginPath(); c.arc(px+24,py+15,3,0,Math.PI*2); c.fill();
      c.fillStyle='rgba(0,0,0,0.25)'; c.fillRect(px,py+TILE-5,TILE,5);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*17 ^ (py/TILE|0)*11) & 0xff;
      c.fillStyle='#0d1a06'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#121e08'; c.fillRect(px+2,py+2,15,13); c.fillRect(px+20,py+18,16,14);
      c.fillStyle='#162408'; c.fillRect(px+18,py+3,16,12); c.fillRect(px+2,py+22,15,14);
      c.fillStyle='#1e4a10';
      [[h%6+2,(h*5)%22+5,3+(h*3)%5],[((h*3)%10+8),(h*11)%20+6,4+(h*7)%4],
       [((h*7)%8+20),(h*13)%18+8,3+(h*2)%5],[((h*11)%9+28),(h*17)%20+5,4+(h*9)%4]].forEach(([tx,ty,th]) => {
        c.fillRect(px+tx,py+ty,2,th); c.fillRect(px+tx+3,py+ty+1,1,th-1);
      });
      if(h%5===0){ c.fillStyle='#4a2808'; c.beginPath(); c.ellipse(px+(h*9)%28+4,py+(h*15)%28+4,5,3,(h%4)*0.5,0,Math.PI*2); c.fill(); }
      if(h%7===0){ c.fillStyle='#e8c830'; c.fillRect(px+(h*5)%24+6,py+(h*11)%24+6,2,2); }
      if(h%9===0){ c.fillStyle='#ff7090'; c.fillRect(px+(h*19)%24+8,py+(h*23)%24+8,2,2); }
      const lr=0.025+0.015*Math.sin(fc*0.02+px*0.05);
      c.fillStyle=`rgba(160,255,80,${lr})`; c.fillRect(px,py,TILE,TILE);
    }
  },

  // ── 1: Пещера (этажи 4-6) ───────────────────────────
  {
    name:'⛏️ Пещера', bg:'#020106', mmFloor:'#201840',
    drawWall(c, px, py, fc) {
      const h = ((px/TILE|0)*19 ^ (py/TILE|0)*23) & 0xff;
      c.fillStyle='#100c1a'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#181428'; c.fillRect(px+2,py+2,18,16); c.fillRect(px+21,py+5,15,12);
      c.fillRect(px+4,py+20,14,14); c.fillRect(px+20,py+22,16,13);
      c.fillStyle='#201c30'; c.fillRect(px+5,py+4,10,10); c.fillRect(px+22,py+23,12,9);
      c.strokeStyle='#0a0812'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+8,py+2); c.lineTo(px+4,py+18); c.stroke();
      c.beginPath(); c.moveTo(px+26,py+5); c.lineTo(px+30,py+22); c.stroke();
      c.beginPath(); c.moveTo(px+2,py+28); c.lineTo(px+14,py+36); c.stroke();
      const glow=0.7+0.3*Math.sin(fc*0.04+px*0.08+py*0.05);
      const stOff=(h%5)*3;
      c.fillStyle=`rgba(80,30,160,${glow*0.9})`;
      [[px+4+stOff,14],[px+14+stOff,11],[px+22+stOff,16]].forEach(([cx2,ch])=>{
        c.beginPath(); c.moveTo(cx2-3,py); c.lineTo(cx2+3,py); c.lineTo(cx2,py+ch); c.closePath(); c.fill();
      });
      c.fillStyle=`rgba(180,120,255,${glow*0.55})`;
      [[px+4+stOff,6],[px+14+stOff,5],[px+22+stOff,7]].forEach(([cx2,ch])=>{
        c.beginPath(); c.moveTo(cx2-1,py+1); c.lineTo(cx2+1,py+1); c.lineTo(cx2,py+ch); c.closePath(); c.fill();
      });
      c.strokeStyle=`rgba(100,40,200,${glow*0.35})`; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+2,py+18); c.lineTo(px+18,py+28); c.lineTo(px+28,py+24); c.stroke();
      c.fillStyle=`rgba(60,40,120,0.06)`; c.fillRect(px,py,TILE,TILE);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*29 ^ (py/TILE|0)*31) & 0xff;
      c.fillStyle='#0c0a16'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#100e1e'; c.fillRect(px+1,py+1,19,19); c.fillRect(px+21,py+21,17,17);
      c.fillStyle='#0e0c1a'; c.fillRect(px+21,py+1,17,19); c.fillRect(px+1,py+21,19,17);
      c.strokeStyle='#080610'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+3,py+16); c.lineTo(px+12,py+24); c.lineTo(px+20,py+20); c.stroke();
      const g=0.07+0.05*Math.sin(fc*0.04+py*0.05+px*0.03);
      c.fillStyle=`rgba(80,30,180,${g})`;
      c.beginPath(); c.ellipse(px+TILE/2,py+TILE/2,11,7,0,0,Math.PI*2); c.fill();
      if(h%5===0){
        const fg=g*2.2;
        c.fillStyle=`rgba(150,80,255,${fg})`;
        c.fillRect(px+(h*7)%26+4,py+(h*13)%26+4,2,2);
        c.fillRect(px+(h*11)%24+6,py+(h*17)%24+6,1,3);
      }
      if(h%3===0){ c.fillStyle=`rgba(100,60,200,0.05)`; c.fillRect(px+(h%24)+2,py+TILE-8,8,4); }
    }
  },

  // ── 2: Руины (этажи 7-9) ────────────────────────────
  {
    name:'🏛️ Руины', bg:'#060402', mmFloor:'#2e2416',
    drawWall(c, px, py) {
      const h = ((px/TILE|0)*37 ^ (py/TILE|0)*41) & 0xff;
      c.fillStyle='#1c1610'; c.fillRect(px,py,TILE,TILE);
      const cols=['#2a2018','#28201a','#262018','#241e16'];
      for(let row=0;row<4;row++){
        const off=row%2===0?0:12, by=py+row*10;
        c.fillStyle=cols[row%4]; c.fillRect(px+off,by+1,20-off,8);
        c.fillStyle='#100c08'; c.fillRect(px+off,by,20-off,1);
        if(off+22<px+TILE){ c.fillStyle=cols[(row+2)%4]; c.fillRect(px+off+21,by+1,TILE-off-22,8); }
        c.fillStyle='rgba(255,220,160,0.04)'; c.fillRect(px+off,by+1,20-off,2);
      }
      c.fillStyle='#100c08';
      for(let row=0;row<4;row++){
        const off=row%2===0?20:0;
        if(off>0) c.fillRect(px+off,py+row*10,1,10);
        c.fillRect(px+32,py+row*10,1,10);
      }
      if(h%3===0){ c.fillStyle='#100c08'; c.fillRect(px,py,4,4); c.fillRect(px+TILE-4,py,4,3); }
      c.fillStyle='#1a3008';
      if(h%4===0){ c.fillRect(px+2,py+8,3,18); c.fillRect(px+3,py+14,5,3); c.fillRect(px+1,py+22,4,4); }
      if(h%5===1){ c.fillRect(px+TILE-5,py+12,3,16); }
      c.fillStyle='rgba(40,30,10,0.14)'; c.fillRect(px,py+TILE-12,TILE,12);
    },
    drawFloor(c, px, py) {
      const h = ((px/TILE|0)*43 ^ (py/TILE|0)*47) & 0xff;
      const dark=((px/TILE|0)+(py/TILE|0))%2===0;
      c.fillStyle=dark?'#201a10':'#1a1408'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle=dark?'#261e14':'#221a0e'; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.fillStyle='rgba(255,210,140,0.04)';
      c.fillRect(px+2,py+2,TILE-4,3); c.fillRect(px+2,py+2,3,TILE-4);
      c.fillStyle='#100e08'; c.fillRect(px,py,TILE,2); c.fillRect(px,py,2,TILE);
      c.fillStyle='rgba(60,50,30,0.07)'; c.fillRect(px+6,py+6,TILE-12,TILE-12);
      if(h%6===0){
        c.fillStyle='#1e3808';
        c.fillRect(px+(h*7)%18+6,py+(h*11)%18+6,2,4);
        c.fillRect(px+(h*13)%16+8,py+(h*17)%16+8,1,3);
      }
      if(h%9===0){
        c.fillStyle='#2a2018';
        c.beginPath(); c.arc(px+(h*5)%22+8,py+(h*19)%22+8,2.5,0,Math.PI*2); c.fill();
      }
    }
  },

  // ── 3: Болото (этажи 10-12) ─────────────────────────
  {
    name:'🌿 Болото', bg:'#020601', mmFloor:'#182e0c',
    drawWall(c, px, py, fc) {
      const h = ((px/TILE|0)*53 ^ (py/TILE|0)*59) & 0xff;
      const wave=fc*0.05;
      c.fillStyle='#080e04'; c.fillRect(px,py,TILE,TILE);
      const tw=9+(h%4), tx2=px+14+(h%6)-3;
      c.fillStyle='#1e1006'; c.fillRect(tx2,py+4,tw,TILE-4);
      c.fillStyle='#160c04'; c.fillRect(tx2+2,py+6,2,TILE-10); c.fillRect(tx2+tw-4,py+8,2,TILE-12);
      c.fillStyle='#1a2e08'; c.fillRect(tx2-1,py+16,4,8); c.fillRect(tx2+tw-3,py+22,4,7);
      c.fillStyle='#1a0e06';
      c.fillRect(px+2,py+10,tx2-px-4,5);
      if(tx2+tw+2 < px+TILE-2) c.fillRect(tx2+tw,py+18,px+TILE-4-(tx2+tw),5);
      c.fillStyle='#120a04'; c.fillRect(px+2,py+9,4,7); c.fillRect(px+TILE-8,py+17,4,7);
      c.fillStyle='#284018';
      [(h%4)*5+4,(h%3)*6+14,(h%5)*4+24].forEach((vx,i)=>{
        const vl=8+(h*(i+3))%10;
        c.fillRect(px+vx,py+TILE-vl-2,2,vl); c.fillRect(px+vx+3,py+TILE-vl,1,vl-3);
      });
      const wy=py+TILE-14+(Math.sin(wave+px*0.06)|0);
      c.fillStyle=`rgba(10,30,6,${0.9+0.1*Math.sin(wave*1.3+py*0.05)})`; c.fillRect(px,wy,TILE,TILE-(wy-py));
      c.fillStyle='rgba(20,50,10,0.55)'; c.fillRect(px+3,wy+2,TILE-6,5);
      c.fillStyle=`rgba(40,80,20,${0.05+0.03*Math.sin(fc*0.03+px*0.04)})`; c.fillRect(px,py,TILE,TILE);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*61 ^ (py/TILE|0)*67) & 0xff;
      const wave=fc*0.04;
      c.fillStyle='#0a140a'; c.fillRect(px,py,TILE,TILE);
      const d1=0.5+0.5*Math.sin(wave+px*0.07+py*0.05);
      c.fillStyle=`rgba(16,30,10,${d1*0.6+0.2})`; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.fillStyle='#16280a'; c.fillRect(px+(h%12)+2,py+(h*3%12)+2,8+h%6,6+h%4);
      c.fillStyle='#1e3610'; c.fillRect(px+(h*5%16)+4,py+(h*7%16)+4,6+h%5,5+h%3);
      if(h%8<4){
        const bt=fc*0.06+h%8;
        c.strokeStyle=`rgba(40,100,20,${0.25+0.25*Math.sin(bt)})`; c.lineWidth=1;
        [[px+8+(h%8)*7,py+15+(h%8)*4],[px+22+(h%8)*3,py+25-(h%8)*2]].forEach(([bx,by])=>{
          c.beginPath(); c.arc(bx,by,2+Math.sin(bt*1.3),0,Math.PI*2); c.stroke();
        });
      }
      if(h%4===0){
        c.fillStyle='#265a10'; c.beginPath(); c.arc(px+TILE/2,py+TILE/2,8,0,Math.PI*2); c.fill();
        c.fillStyle='#0a140a'; c.beginPath(); c.moveTo(px+TILE/2,py+TILE/2); c.lineTo(px+TILE/2-3,py+TILE/2-8); c.lineTo(px+TILE/2+3,py+TILE/2-8); c.fill();
        c.fillStyle='#e8c8e0'; c.beginPath(); c.arc(px+TILE/2,py+TILE/2-8,2.5,0,Math.PI*2); c.fill();
        c.fillStyle='#ffe060'; c.beginPath(); c.arc(px+TILE/2,py+TILE/2-8,1.2,0,Math.PI*2); c.fill();
      }
      c.fillStyle=`rgba(50,100,30,${0.055+0.035*Math.sin(fc*0.025+px*0.03+py*0.04)})`; c.fillRect(px,py,TILE,TILE);
    }
  },

  // ── 4: Тундра / Лёд (этажи 13-15) ──────────────────
  {
    name:'❄️ Тундра', bg:'#010308', mmFloor:'#182840',
    drawWall(c, px, py, fc) {
      const h = ((px/TILE|0)*71 ^ (py/TILE|0)*73) & 0xff;
      const glint=fc*0.07;
      c.fillStyle='#0e1c30'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#142238'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      const bcs=['#1c3252','#1e3458','#22385e','#203460'];
      for(let row=0;row<3;row++){
        const bh=12+(h*(row+1))%4, by=py+row*13;
        c.fillStyle=bcs[row%4]; c.fillRect(px+2,by+2,TILE-4,bh-2);
        c.fillStyle='rgba(180,220,255,0.05)'; c.fillRect(px+2,by+3,TILE-4,2); c.fillRect(px+2,by+bh-4,TILE-4,2);
        c.fillStyle='#0c1828'; c.fillRect(px,by+bh,TILE,2);
      }
      c.fillStyle='#d4ecf8'; c.fillRect(px,py,TILE,4);
      c.fillStyle='#ffffff'; c.fillRect(px+4,py,TILE-8,2);
      c.fillStyle='#e8f4ff';
      [[4,4],[12,3],[22,5],[30,3],[36,4]].forEach(([sx,sh])=>{
        c.beginPath(); c.ellipse(px+sx,py,sh+1,sh/2+2,0,-Math.PI,0); c.fill();
      });
      c.fillStyle='rgba(160,210,255,0.88)';
      [[3,10],[9,7],[15,12],[22,8],[28,11],[34,7]].forEach(([ix,ih])=>{
        if(px+ix+3<px+TILE-2){
          c.beginPath(); c.moveTo(px+ix,py+4); c.lineTo(px+ix+3,py+4); c.lineTo(px+ix+1.5,py+4+ih); c.closePath(); c.fill();
          c.fillStyle='rgba(240,250,255,0.65)'; c.fillRect(px+ix+1,py+4,1,ih/2);
          c.fillStyle='rgba(160,210,255,0.88)';
        }
      });
      const sh=0.09+0.07*Math.sin(glint+px*0.06+py*0.08);
      c.fillStyle=`rgba(180,230,255,${sh})`; c.fillRect(px+3,py+6,8,5);
      c.fillStyle=`rgba(200,240,255,${sh*0.65})`; c.fillRect(px+TILE-11,py+16,8,4);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*79 ^ (py/TILE|0)*83) & 0xff;
      const glint=fc*0.06;
      c.fillStyle='#0a1824'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#0e2030'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      c.fillStyle='#102438'; c.fillRect(px+4,py+4,TILE-8,TILE-8);
      c.strokeStyle='#1a3850'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+(h%8)+2,py+(h*3%14)+2); c.lineTo(px+(h*5%12)+8,py+(h*7%12)+12); c.lineTo(px+(h*11%14)+14,py+(h*13%10)+8); c.stroke();
      c.beginPath(); c.moveTo(px+(h*7%10)+18,py+(h*17%8)+16); c.lineTo(px+(h*3%8)+24,py+(h*5%14)+22); c.stroke();
      c.strokeStyle='#060e18'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+6,py+22); c.lineTo(px+20,py+30); c.stroke();
      const sp=0.07+0.06*Math.sin(glint+px*0.05+py*0.04);
      c.fillStyle=`rgba(140,200,255,${sp})`; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      if(((px/TILE|0)+(py/TILE|0)*2)%3===0){
        c.fillStyle='rgba(220,240,255,0.13)'; c.fillRect(px+2,py+TILE-6,TILE-4,5);
      }
      if(h%4===0){
        c.fillStyle=`rgba(255,255,255,${0.6+0.4*Math.sin(glint*2+h)})`;
        c.fillRect(px+(h*7)%TILE,py+(h*13)%TILE,2,2);
      }
    }
  },

  // ── 5: Вулкан (этажи 16-18) ─────────────────────────
  {
    name:'🌋 Вулкан', bg:'#060100', mmFloor:'#301002',
    drawWall(c, px, py, fc) {
      const h = ((px/TILE|0)*89 ^ (py/TILE|0)*97) & 0xff;
      const lv=fc*0.08;
      c.fillStyle='#140402'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#1c0804'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      c.fillStyle='#240e06'; c.fillRect(px+3,py+4,16,9);
      c.fillStyle='#200c04'; c.fillRect(px+21,py+17,15,9);
      c.fillStyle='#1c0a02'; c.fillRect(px+4,py+24,14,12);
      c.fillStyle='#260e06'; c.fillRect(px+22,py+6,13,9);
      c.fillStyle='#0e0402'; c.fillRect(px+10,py+2,2,20); c.fillRect(px+28,py+14,2,18);
      c.fillStyle='rgba(100,20,0,0.14)'; c.fillRect(px+10,py+2,1,20); c.fillRect(px+28,py+14,1,18);
      const la=0.65+0.35*Math.sin(lv+px*0.05);
      const gr=60+30*Math.sin(lv*0.7+py*0.04)|0;
      c.fillStyle=`rgba(255,${gr},0,${la})`;
      c.fillRect(px+1,py+12,4,18); c.fillRect(px+TILE-5,py+8,4,20);
      c.fillStyle=`rgba(255,${160+80*Math.sin(lv+0.5)|0},10,${la*0.8})`;
      c.fillRect(px+2,py+14,2,14); c.fillRect(px+TILE-4,py+10,2,16);
      c.fillStyle=`rgba(160,20,0,${la*0.07})`; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='rgba(60,40,30,0.3)'; c.fillRect(px+2,py+TILE-8,TILE-4,8);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*101 ^ (py/TILE|0)*103) & 0xff;
      const lv=fc*0.07;
      c.fillStyle='#0e0200'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#160602'; c.fillRect(px+1,py+1,18,18); c.fillRect(px+21,py+21,17,17);
      c.fillStyle='#140401'; c.fillRect(px+21,py+1,17,18); c.fillRect(px+1,py+21,18,17);
      c.strokeStyle='rgba(60,10,0,0.55)'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+2,py+TILE/2); c.lineTo(px+TILE/2,py+TILE/2-6); c.lineTo(px+TILE-2,py+TILE/2+2); c.stroke();
      c.beginPath(); c.moveTo(px+TILE/2,py+2); c.lineTo(px+TILE/2+4,py+TILE/2); c.lineTo(px+TILE/2,py+TILE-2); c.stroke();
      const la=0.4+0.35*Math.sin(lv+(px+py)*0.06);
      c.strokeStyle=`rgba(220,${40+20*Math.sin(lv)|0},0,${la})`; c.lineWidth=2;
      c.beginPath(); c.moveTo(px+4,py+TILE/2+1); c.lineTo(px+TILE/2,py+TILE/2-4); c.lineTo(px+TILE-4,py+TILE/2+3); c.stroke();
      if(((px/TILE|0)+(py/TILE|0)*3)%4===0){
        c.fillStyle=`rgba(255,${80+60*Math.sin(lv*1.3)|0},10,${la*0.8})`; c.beginPath(); c.arc(px+TILE/2,py+TILE/2,4,0,Math.PI*2); c.fill();
        c.fillStyle=`rgba(255,${200+55*Math.sin(lv*0.9)|0},30,${la*0.6})`; c.beginPath(); c.arc(px+TILE/2,py+TILE/2,2,0,Math.PI*2); c.fill();
      }
      if(h%5===0){ c.fillStyle='rgba(50,30,20,0.18)'; c.fillRect(px+(h*7)%24+4,py+(h*11)%24+4,10+h%6,3); }
    }
  },

  // ── 6: Бездна (этажи 19-20) ─────────────────────────
  {
    name:'🌑 Бездна', bg:'#000000', mmFloor:'#14061e',
    drawWall(c, px, py, fc) {
      const h = ((px/TILE|0)*107 ^ (py/TILE|0)*109) & 0xff;
      const pw=fc*0.04;
      c.fillStyle='#030008'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#06000e'; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.fillStyle='#0a0018'; c.fillRect(px+4,py+6,14,10); c.fillRect(px+20,py+4,14,8);
      c.fillStyle='#0c001c'; c.fillRect(px+3,py+22,13,12); c.fillRect(px+21,py+20,13,10);
      const eg=0.35+0.25*Math.sin(pw+py*0.06);
      c.fillStyle=`rgba(100,0,200,${eg})`;
      c.fillRect(px,py,TILE,2); c.fillRect(px,py+TILE-2,TILE,2);
      c.fillRect(px,py,2,TILE); c.fillRect(px+TILE-2,py,2,TILE);
      c.strokeStyle=`rgba(140,20,255,${eg*0.75})`; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+6,py+8); c.lineTo(px+14,py+22); c.lineTo(px+8,py+32); c.stroke();
      c.beginPath(); c.moveTo(px+26,py+6); c.lineTo(px+32,py+20); c.lineTo(px+24,py+30); c.stroke();
      if(h%4===0||h%4===2){
        const ey=0.5+0.4*Math.sin(pw*1.2+h*0.1);
        const ex1=px+9+(h%6), ey1=py+TILE/2+(h%4-2)*3;
        const ex2=px+27-(h%5), ey2=py+TILE/2+(h%3-1)*4;
        c.fillStyle=`rgba(100,0,200,${ey*0.28})`;
        c.beginPath(); c.arc(ex1,ey1,6,0,Math.PI*2); c.fill();
        c.beginPath(); c.arc(ex2,ey2,6,0,Math.PI*2); c.fill();
        c.fillStyle=`rgba(160,0,255,${ey})`;
        c.beginPath(); c.arc(ex1,ey1,3.5,0,Math.PI*2); c.fill();
        c.beginPath(); c.arc(ex2,ey2,3.5,0,Math.PI*2); c.fill();
        c.fillStyle=`rgba(255,200,255,${ey*0.85})`;
        c.beginPath(); c.arc(ex1,ey1,1.5,0,Math.PI*2); c.fill();
        c.beginPath(); c.arc(ex2,ey2,1.5,0,Math.PI*2); c.fill();
      }
      c.fillStyle=`rgba(60,0,120,${0.05+0.04*Math.sin(pw*0.7+px*0.03+py*0.04)})`; c.fillRect(px,py,TILE,TILE);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*113 ^ (py/TILE|0)*127) & 0xff;
      const pw=fc*0.035;
      c.fillStyle='#010005'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#020008'; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.strokeStyle='rgba(60,0,100,0.38)'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+(h%8)+2,py+(h*3%10)+2); c.lineTo(px+(h*5%12)+10,py+(h*7%12)+12); c.lineTo(px+(h*11%10)+16,py+(h*13%8)+20); c.stroke();
      [[h%28+4,(h*7)%28+4],[(h*11)%26+6,(h*13)%26+6],[(h*17)%24+8,(h*19)%24+8]].forEach(([sx,sy],i)=>{
        const sg=0.15+0.15*Math.sin(pw*2+h+i);
        c.fillStyle=`rgba(${120+i*40},${40+i*20},255,${sg})`; c.fillRect(px+sx,py+sy,h%2+1,h%2+1);
      });
      if(h%5===0){
        c.fillStyle=`rgba(220,180,255,${0.7+0.3*Math.sin(pw*3+h*0.2)})`;
        c.fillRect(px+(h*7)%30+4,py+(h*23)%30+4,2,2);
      }
      c.fillStyle=`rgba(50,0,100,${0.04+0.03*Math.sin(pw+px*0.02+py*0.02)})`; c.fillRect(px,py,TILE,TILE);
      if(h%8===0){
        c.strokeStyle=`rgba(120,0,220,${0.06+0.05*Math.sin(pw*1.5+h)})`; c.lineWidth=1;
        c.beginPath(); c.arc(px+TILE/2,py+TILE/2,8+Math.sin(pw*2+h)*3,0,Math.PI*2); c.stroke();
      }
    }
  },
];

function getTheme(lvl) {
  return THEMES[Math.min(Math.floor((lvl - 1) / 3), 6)];
}
