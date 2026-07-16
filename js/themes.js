// ─────────────────────────────────────────────────────────
//  LOCATION THEMES  (3 floors each, 7 themes for 20 floors)
//  drawWall(c, px, py, fc, nb) is called ONLY on edge tiles
//  (adjacent to floor). nb = {top,bottom,left,right,...}
// ─────────────────────────────────────────────────────────
const THEMES = [

  // ── 0: Лес (этажи 1-3) ──────────────────────────────
  {
    name:'🌲 Лес', bg:'#020a02', mmFloor:'#1e4010',
    wallBase: '#030a02',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*13 ^ (py/TILE|0)*7) & 0xff;
      // Tree trunk — draw if floor is below or to side
      if (nb && (nb.bottom || nb.left || nb.right)) {
        const tw = 7+(h%3), tx2 = px+15+(h%5)-2;
        c.fillStyle='#2c1608'; c.fillRect(tx2,py,tw,TILE);
        c.fillStyle='#3c2010'; c.fillRect(tx2+1,py,2,TILE);
        c.fillStyle='#1e0e04'; c.fillRect(tx2+tw-3,py,2,TILE);
        for(let i=0;i<4;i++){ c.fillStyle='#1a0c04'; c.fillRect(tx2+1,py+8+i*8,tw-2,1); }
        // roots spilling onto floor
        if(nb.bottom){
          c.fillStyle='#241408';
          c.fillRect(tx2-5,py+TILE-8,5,8); c.fillRect(tx2+tw,py+TILE-8,5,8);
          c.fillRect(tx2-3,py+TILE-4,3,4); c.fillRect(tx2+tw,py+TILE-4,3,4);
        }
      }
      // Big organic foliage — always visible from floor tiles
      c.fillStyle='#0a2206';
      c.beginPath(); c.ellipse(px+20,py+22,19,14,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+10,py+28,14,11,0.15,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+30,py+25,14,11,-0.15,0,Math.PI*2); c.fill();
      c.fillStyle='#144a0a';
      c.beginPath(); c.ellipse(px+20,py+14,16,13,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+10,py+20,13,10,0.2,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+30,py+19,13,10,-0.2,0,Math.PI*2); c.fill();
      c.fillStyle='#1c6410';
      c.beginPath(); c.ellipse(px+20,py+8,12,10,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+13,py+13,9,8,0.1,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+27,py+12,9,8,-0.1,0,Math.PI*2); c.fill();
      // Light dabs
      c.fillStyle='rgba(80,200,30,0.13)';
      c.beginPath(); c.arc(px+16,py+12,4,0,Math.PI*2); c.fill();
      c.beginPath(); c.arc(px+25,py+15,3,0,Math.PI*2); c.fill();
      c.beginPath(); c.arc(px+12,py+20,3,0,Math.PI*2); c.fill();
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*17 ^ (py/TILE|0)*11) & 0xff;
      // Seamless grass base
      c.fillStyle = h < 85 ? '#0d1a06' : h < 170 ? '#0f1c07' : '#111f08';
      c.fillRect(px,py,TILE,TILE);
      // Subtle patches
      c.fillStyle = h < 128 ? '#121f08' : '#141f09';
      c.fillRect(px+(h%7)+1,py+(h*3%9)+1,12+h%7,10+h%5);
      c.fillRect(px+(h*5%11)+14,py+(h*7%9)+14,11+h%6,9+h%4);
      // Grass blades
      c.fillStyle='#1e4a10';
      for(let i=0;i<5;i++){
        const gx=px+(h*3+i*8)%32+2, gy=py+(h*5+i*7)%28+4;
        c.fillRect(gx,gy,1,3+i%3);
        c.fillRect(gx+3,gy+1,1,2+i%2);
      }
      if(h%5===0){ c.fillStyle='#ff7090'; c.fillRect(px+(h*5)%24+6,py+(h*11)%24+6,2,2); }
      if(h%7===0){ c.fillStyle='#e8c830'; c.fillRect(px+(h*11)%22+8,py+(h*13)%22+8,2,2); }
    }
  },

  // ── 1: Пещера (этажи 4-6) ───────────────────────────
  {
    name:'⛏️ Пещера', bg:'#020106', mmFloor:'#201840',
    wallBase: '#06040e',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*19 ^ (py/TILE|0)*23) & 0xff;
      const glow = 0.7+0.3*Math.sin((fc||0)*0.04+px*0.08+py*0.05);
      // Stone face
      c.fillStyle='#10091e'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      c.fillStyle='#16102a'; c.fillRect(px+3,py+4,16,11); c.fillRect(px+20,py+6,14,10);
      c.fillStyle='#1e1836'; c.fillRect(px+5,py+5,10,9); c.fillRect(px+22,py+7,10,8);
      // Cracks
      c.strokeStyle='#06040e'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+8,py+2); c.lineTo(px+4,py+18); c.stroke();
      c.beginPath(); c.moveTo(px+26,py+5); c.lineTo(px+30,py+20); c.stroke();
      // Crystals only near floor
      if(nb && (nb.bottom||nb.left||nb.right)){
        const stOff=(h%5)*3;
        c.fillStyle=`rgba(80,30,160,${glow*0.9})`;
        [[px+4+stOff,15],[px+14+stOff,12],[px+23+stOff,17]].forEach(([cx2,ch])=>{
          c.beginPath(); c.moveTo(cx2-4,py+TILE); c.lineTo(cx2+4,py+TILE); c.lineTo(cx2,py+TILE-ch); c.closePath(); c.fill();
        });
        c.fillStyle=`rgba(180,120,255,${glow*0.55})`;
        [[px+4+stOff,7],[px+14+stOff,6],[px+23+stOff,8]].forEach(([cx2,ch])=>{
          c.beginPath(); c.moveTo(cx2-1.5,py+TILE-1); c.lineTo(cx2+1.5,py+TILE-1); c.lineTo(cx2,py+TILE-ch); c.closePath(); c.fill();
        });
      }
      // Stalactites from ceiling
      if(nb && nb.top){
        c.fillStyle=`rgba(80,30,160,${glow*0.8})`;
        [[3,14],[11,11],[20,16],[29,12]].forEach(([sx,sh])=>{
          c.beginPath(); c.moveTo(px+sx-4,py); c.lineTo(px+sx+4,py); c.lineTo(px+sx,py+sh); c.closePath(); c.fill();
        });
      }
      c.strokeStyle=`rgba(100,40,200,${glow*0.3})`; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+2,py+18); c.lineTo(px+18,py+28); c.lineTo(px+30,py+24); c.stroke();
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*29 ^ (py/TILE|0)*31) & 0xff;
      const g2=0.07+0.05*Math.sin((fc||0)*0.04+py*0.05+px*0.03);
      c.fillStyle='#0c0a16'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#100e1e'; c.fillRect(px+1,py+1,19,19); c.fillRect(px+21,py+21,17,17);
      c.fillStyle='#0e0c1a'; c.fillRect(px+21,py+1,17,19); c.fillRect(px+1,py+21,19,17);
      c.strokeStyle='#080610'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+3,py+16); c.lineTo(px+12,py+24); c.lineTo(px+20,py+20); c.stroke();
      c.fillStyle=`rgba(80,30,180,${g2})`;
      c.beginPath(); c.ellipse(px+TILE/2,py+TILE/2,11,7,0,0,Math.PI*2); c.fill();
      if(h%5===0){
        const fg=g2*2.2;
        c.fillStyle=`rgba(150,80,255,${fg})`;
        c.fillRect(px+(h*7)%26+4,py+(h*13)%26+4,2,2);
        c.fillRect(px+(h*11)%24+6,py+(h*17)%24+6,1,3);
      }
    }
  },

  // ── 2: Руины (этажи 7-9) ────────────────────────────
  {
    name:'🏛️ Руины', bg:'#060402', mmFloor:'#2e2416',
    wallBase: '#100c08',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*37 ^ (py/TILE|0)*41) & 0xff;
      // Stone block face — brick pattern
      const cols=['#2a2018','#28201a','#262018','#241e16'];
      for(let row=0;row<4;row++){
        const off=row%2===0?0:12, by=py+row*10;
        c.fillStyle=cols[row%4]; c.fillRect(px+off,by+1,20-off,8);
        c.fillStyle='rgba(255,220,160,0.04)'; c.fillRect(px+off,by+1,20-off,2);
        if(off+22<px+TILE){ c.fillStyle=cols[(row+2)%4]; c.fillRect(px+off+21,by+1,TILE-off-22,8); }
      }
      // Mortar lines
      c.fillStyle='#0c0906';
      for(let row=0;row<4;row++){ c.fillRect(px,py+row*10,TILE,1); }
      const off2=h%2===0?0:12;
      c.fillRect(px+off2,py,1,TILE); c.fillRect(px+off2+21,py,1,TILE); c.fillRect(px+TILE-1,py,1,TILE);
      // Vines near floor
      if(nb && nb.bottom){
        c.fillStyle='#1a3008';
        c.fillRect(px+(h*3)%22+2,py+TILE-18,3,18); c.fillRect(px+(h*3)%22+5,py+TILE-10,1,10);
        c.fillRect(px+(h*7)%20+14,py+TILE-14,2,14); c.fillRect(px+(h*7)%20+16,py+TILE-7,1,7);
        if(h%3===0){ c.fillStyle='#2a4808'; c.beginPath(); c.ellipse(px+(h*3)%22+1,py+TILE-19,4,3,0,0,Math.PI*2); c.fill(); }
      }
      // Crumble at top
      if(nb && nb.top){
        c.fillStyle='#100c08';
        if(h%3===0){ c.fillRect(px,py,4,4); c.fillRect(px+TILE-4,py,4,3); }
        c.fillStyle='#241e14';
        [[h%8,4],[h%6+12,3],[h%7+24,5]].forEach(([sx,sw])=>{
          c.beginPath(); c.moveTo(px+sx,py); c.lineTo(px+sx+sw,py); c.lineTo(px+sx+sw/2,py+5); c.fill();
        });
      }
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*43 ^ (py/TILE|0)*47) & 0xff;
      const dark=((px/TILE|0)+(py/TILE|0))%2===0;
      c.fillStyle=dark?'#201a10':'#1a1408'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle=dark?'#261e14':'#221a0e'; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.fillStyle='rgba(255,210,140,0.04)';
      c.fillRect(px+2,py+2,TILE-4,3); c.fillRect(px+2,py+2,3,TILE-4);
      c.fillStyle='#100e08'; c.fillRect(px,py,TILE,2); c.fillRect(px,py,2,TILE);
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
    wallBase: '#040a03',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*53 ^ (py/TILE|0)*59) & 0xff;
      const wave = (fc||0)*0.05;
      // Dark swampy base
      c.fillStyle='#060e04'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      // Twisted tree trunk
      const tw=8+(h%4), tx2=px+14+(h%6)-3;
      c.fillStyle='#1e1006'; c.fillRect(tx2,py,tw,TILE);
      c.fillStyle='#160c04'; c.fillRect(tx2+2,py,2,TILE); c.fillRect(tx2+tw-4,py,2,TILE);
      // Gnarled knots
      c.fillStyle='#281408';
      [[4,8],[16,6],[28,10]].forEach(([ky,kw])=>{ if(ky>0) c.fillRect(tx2-2,py+ky,tw+4,kw*0.5|0); });
      // Roots/branches near floor
      if(nb && nb.bottom){
        c.fillStyle='#1a2e08'; c.fillRect(tx2-1,py+TILE-16,4,16); c.fillRect(tx2+tw-3,py+TILE-12,4,12);
        c.fillRect(tx2-8,py+TILE-6,8,3); c.fillRect(tx2+tw,py+TILE-8,7,3);
      }
      // Reeds on the sides
      if(nb && (nb.left||nb.right)){
        c.fillStyle='#284018';
        [(h%4)*5+4,(h%3)*6+14,(h%5)*4+22].forEach((vx,i)=>{
          const vl=8+(h*(i+3))%12;
          c.fillRect(px+vx,py+TILE-vl,2,vl); c.fillRect(px+vx+3,py+TILE-vl+2,1,vl-3);
        });
      }
      // Canopy / hanging moss
      c.fillStyle='#0c2206';
      c.beginPath(); c.ellipse(px+20,py+10,18,12,0,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+10,py+16,12,9,0.2,0,Math.PI*2); c.fill();
      c.beginPath(); c.ellipse(px+30,py+14,12,9,-0.2,0,Math.PI*2); c.fill();
      c.fillStyle='#164a0a';
      c.beginPath(); c.ellipse(px+20,py+4,13,10,0,0,Math.PI*2); c.fill();
      c.fillStyle=`rgba(40,80,20,${0.05+0.03*Math.sin(wave+px*0.04)})`;
      c.fillRect(px,py,TILE,TILE);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*61 ^ (py/TILE|0)*67) & 0xff;
      const wave=(fc||0)*0.04;
      c.fillStyle='#0a140a'; c.fillRect(px,py,TILE,TILE);
      const d1=0.5+0.5*Math.sin(wave+px*0.07+py*0.05);
      c.fillStyle=`rgba(16,30,10,${d1*0.6+0.2})`; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.fillStyle='#16280a'; c.fillRect(px+(h%12)+2,py+(h*3%12)+2,8+h%6,6+h%4);
      c.fillStyle='#1e3610'; c.fillRect(px+(h*5%16)+4,py+(h*7%16)+4,6+h%5,5+h%3);
      if(h%4===0){
        c.fillStyle='#265a10'; c.beginPath(); c.arc(px+TILE/2,py+TILE/2,8,0,Math.PI*2); c.fill();
        c.fillStyle='#0a140a'; c.beginPath(); c.moveTo(px+TILE/2,py+TILE/2); c.lineTo(px+TILE/2-3,py+TILE/2-8); c.lineTo(px+TILE/2+3,py+TILE/2-8); c.fill();
        c.fillStyle='#e8c8e0'; c.beginPath(); c.arc(px+TILE/2,py+TILE/2-8,2.5,0,Math.PI*2); c.fill();
        c.fillStyle='#ffe060'; c.beginPath(); c.arc(px+TILE/2,py+TILE/2-8,1.2,0,Math.PI*2); c.fill();
      }
      c.fillStyle=`rgba(50,100,30,${0.055+0.035*Math.sin((fc||0)*0.025+px*0.03+py*0.04)})`; c.fillRect(px,py,TILE,TILE);
    }
  },

  // ── 4: Тундра / Лёд (этажи 13-15) ──────────────────
  {
    name:'❄️ Тундра', bg:'#010308', mmFloor:'#182840',
    wallBase: '#060c18',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*71 ^ (py/TILE|0)*73) & 0xff;
      const glint=(fc||0)*0.07;
      // Ice block base
      const bcs=['#1c3252','#1e3458','#22385e','#203460'];
      for(let row=0;row<3;row++){
        const bh=12+(h*(row+1))%4, by=py+row*13;
        c.fillStyle=bcs[row%4]; c.fillRect(px+2,by+2,TILE-4,bh-2);
        c.fillStyle='rgba(180,220,255,0.05)'; c.fillRect(px+2,by+3,TILE-4,2);
        c.fillStyle='#0c1828'; c.fillRect(px,by+bh,TILE,2);
      }
      // Snow cap on top
      if(nb && nb.top){
        c.fillStyle='#e8f4ff'; c.fillRect(px,py,TILE,3);
        c.fillStyle='#d4ecf8'; c.fillRect(px+2,py,TILE-4,5);
        [[4,4],[12,3],[22,5],[30,3],[36,4]].forEach(([sx,sh])=>{
          c.fillStyle='#e8f4ff';
          c.beginPath(); c.ellipse(px+sx,py,sh+1,sh/2+2,0,-Math.PI,0); c.fill();
        });
      }
      // Icicles hanging down near floor
      if(nb && nb.bottom){
        c.fillStyle='rgba(160,210,255,0.9)';
        [[3,10],[9,7],[15,12],[22,8],[28,11],[34,7]].forEach(([ix,ih])=>{
          if(px+ix+3<px+TILE-2){
            c.beginPath(); c.moveTo(px+ix,py+TILE-2); c.lineTo(px+ix+3,py+TILE-2); c.lineTo(px+ix+1.5,py+TILE+ih-2); c.closePath(); c.fill();
            c.fillStyle='rgba(240,250,255,0.65)'; c.fillRect(px+ix+1,py+TILE-2,1,ih*0.5|0);
            c.fillStyle='rgba(160,210,255,0.9)';
          }
        });
      }
      const sh=0.08+0.06*Math.sin(glint+px*0.06+py*0.08);
      c.fillStyle=`rgba(180,230,255,${sh})`; c.fillRect(px+3,py+6,8,5);
      c.fillStyle=`rgba(200,240,255,${sh*0.65})`; c.fillRect(px+TILE-11,py+16,8,4);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*79 ^ (py/TILE|0)*83) & 0xff;
      const glint=(fc||0)*0.06;
      c.fillStyle='#0a1824'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#0e2030'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      c.fillStyle='#102438'; c.fillRect(px+4,py+4,TILE-8,TILE-8);
      c.strokeStyle='#1a3850'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+(h%8)+2,py+(h*3%14)+2); c.lineTo(px+(h*5%12)+8,py+(h*7%12)+12); c.lineTo(px+(h*11%14)+14,py+(h*13%10)+8); c.stroke();
      const sp=0.07+0.06*Math.sin(glint+px*0.05+py*0.04);
      c.fillStyle=`rgba(140,200,255,${sp})`; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      if(((px/TILE|0)+(py/TILE|0)*2)%3===0){
        c.fillStyle='rgba(220,240,255,0.12)'; c.fillRect(px+2,py+TILE-6,TILE-4,5);
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
    wallBase: '#0a0200',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*89 ^ (py/TILE|0)*97) & 0xff;
      const lv=(fc||0)*0.08;
      // Volcanic rock face
      c.fillStyle='#180604'; c.fillRect(px+1,py+1,TILE-2,TILE-2);
      c.fillStyle='#200e06'; c.fillRect(px+3,py+3,16,11); c.fillRect(px+21,py+16,15,10);
      c.fillStyle='#240e06'; c.fillRect(px+22,py+6,13,10); c.fillRect(px+4,py+22,15,12);
      c.fillStyle='#0e0402'; c.fillRect(px+10,py+2,2,TILE); c.fillRect(px+28,py+14,2,TILE);
      // Lava cracks near floor
      if(nb && (nb.bottom||nb.left||nb.right)){
        const la=0.65+0.35*Math.sin(lv+px*0.05);
        const gr=60+30*Math.sin(lv*0.7+py*0.04)|0;
        c.fillStyle=`rgba(255,${gr},0,${la})`;
        c.fillRect(px+1,py+TILE-20,4,20); c.fillRect(px+TILE-5,py+TILE-18,4,18);
        c.fillStyle=`rgba(255,${160+80*Math.sin(lv+0.5)|0},10,${la*0.8})`;
        c.fillRect(px+2,py+TILE-16,2,16); c.fillRect(px+TILE-4,py+TILE-13,2,13);
      }
      // Glow veins running through
      const la2=0.4+0.35*Math.sin(lv+(px+py)*0.04);
      c.strokeStyle=`rgba(220,${50+20*Math.sin(lv)|0},0,${la2})`; c.lineWidth=1.5;
      c.beginPath(); c.moveTo(px+6,py+4); c.quadraticCurveTo(px+18,py+18,px+30,py+30); c.stroke();
      c.beginPath(); c.moveTo(px+30,py+6); c.quadraticCurveTo(px+14,py+20,px+4,py+28); c.stroke();
      c.fillStyle=`rgba(160,20,0,${la2*0.06})`; c.fillRect(px,py,TILE,TILE);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*101 ^ (py/TILE|0)*103) & 0xff;
      const lv=(fc||0)*0.07;
      c.fillStyle='#0e0200'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#160602'; c.fillRect(px+1,py+1,18,18); c.fillRect(px+21,py+21,17,17);
      c.fillStyle='#140401'; c.fillRect(px+21,py+1,17,18); c.fillRect(px+1,py+21,18,17);
      c.strokeStyle='rgba(60,10,0,0.55)'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+2,py+TILE/2); c.lineTo(px+TILE/2,py+TILE/2-6); c.lineTo(px+TILE-2,py+TILE/2+2); c.stroke();
      const la=0.4+0.35*Math.sin(lv+(px+py)*0.06);
      c.strokeStyle=`rgba(220,${40+20*Math.sin(lv)|0},0,${la})`; c.lineWidth=2;
      c.beginPath(); c.moveTo(px+4,py+TILE/2+1); c.lineTo(px+TILE/2,py+TILE/2-4); c.lineTo(px+TILE-4,py+TILE/2+3); c.stroke();
      if(((px/TILE|0)+(py/TILE|0)*3)%4===0){
        c.fillStyle=`rgba(255,${80+60*Math.sin(lv*1.3)|0},10,${la*0.8})`; c.beginPath(); c.arc(px+TILE/2,py+TILE/2,4,0,Math.PI*2); c.fill();
        c.fillStyle=`rgba(255,${200+55*Math.sin(lv*0.9)|0},30,${la*0.6})`; c.beginPath(); c.arc(px+TILE/2,py+TILE/2,2,0,Math.PI*2); c.fill();
      }
    }
  },

  // ── 6: Бездна (этажи 19-20) ─────────────────────────
  {
    name:'🌑 Бездна', bg:'#000000', mmFloor:'#14061e',
    wallBase: '#010004',
    drawWall(c, px, py, fc, nb) {
      const h = ((px/TILE|0)*107 ^ (py/TILE|0)*109) & 0xff;
      const pw=(fc||0)*0.04;
      // Void substance
      c.fillStyle='#050010'; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.fillStyle='#080018'; c.fillRect(px+4,py+6,14,10); c.fillRect(px+20,py+4,14,8);
      c.fillStyle='#0c001c'; c.fillRect(px+3,py+22,13,12); c.fillRect(px+21,py+20,13,10);
      const eg=0.35+0.25*Math.sin(pw+py*0.06);
      // Void border glow
      c.fillStyle=`rgba(100,0,200,${eg})`;
      c.fillRect(px,py,TILE,2); c.fillRect(px,py+TILE-2,TILE,2);
      c.fillRect(px,py,2,TILE); c.fillRect(px+TILE-2,py,2,TILE);
      // Eye/rune decorations near floor
      if(nb && (nb.bottom||nb.left||nb.right)){
        const ey2=0.5+0.4*Math.sin(pw*1.2+h*0.1);
        const ex1=px+9+(h%6), ey1=py+TILE/2+(h%4-2)*3;
        const ex2=px+27-(h%5), ey3=py+TILE/2+(h%3-1)*4;
        c.fillStyle=`rgba(100,0,200,${ey2*0.28})`;
        c.beginPath(); c.arc(ex1,ey1,7,0,Math.PI*2); c.fill();
        c.beginPath(); c.arc(ex2,ey3,7,0,Math.PI*2); c.fill();
        c.fillStyle=`rgba(160,0,255,${ey2})`;
        c.beginPath(); c.arc(ex1,ey1,4,0,Math.PI*2); c.fill();
        c.beginPath(); c.arc(ex2,ey3,4,0,Math.PI*2); c.fill();
        c.fillStyle=`rgba(255,200,255,${ey2*0.9})`;
        c.beginPath(); c.arc(ex1,ey1,1.8,0,Math.PI*2); c.fill();
        c.beginPath(); c.arc(ex2,ey3,1.8,0,Math.PI*2); c.fill();
      }
      // Tendrils
      c.strokeStyle=`rgba(120,0,220,${eg*0.55})`; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+6,py+8); c.quadraticCurveTo(px+14,py+20,px+8,py+32); c.stroke();
      c.beginPath(); c.moveTo(px+26,py+6); c.quadraticCurveTo(px+32,py+20,px+24,py+30); c.stroke();
      c.fillStyle=`rgba(60,0,120,${0.05+0.04*Math.sin(pw*0.7+px*0.03+py*0.04)})`; c.fillRect(px,py,TILE,TILE);
    },
    drawFloor(c, px, py, fc) {
      const h = ((px/TILE|0)*113 ^ (py/TILE|0)*127) & 0xff;
      const pw=(fc||0)*0.035;
      c.fillStyle='#010005'; c.fillRect(px,py,TILE,TILE);
      c.fillStyle='#020008'; c.fillRect(px+2,py+2,TILE-4,TILE-4);
      c.strokeStyle='rgba(60,0,100,0.38)'; c.lineWidth=1;
      c.beginPath(); c.moveTo(px+(h%8)+2,py+(h*3%10)+2); c.lineTo(px+(h*5%12)+10,py+(h*7%12)+12); c.lineTo(px+(h*11%10)+16,py+(h*13%8)+20); c.stroke();
      [[h%28+4,(h*7)%28+4],[(h*11)%26+6,(h*13)%26+6],[(h*17)%24+8,(h*19)%24+8]].forEach(([sx,sy],i)=>{
        const sg=0.15+0.15*Math.sin((pw||0)*2+h+i);
        c.fillStyle=`rgba(${120+i*40},${40+i*20},255,${sg})`; c.fillRect(px+sx,py+sy,h%2+1,h%2+1);
      });
      if(h%5===0){
        c.fillStyle=`rgba(220,180,255,${0.7+0.3*Math.sin((pw||0)*3+h*0.2)})`;
        c.fillRect(px+(h*7)%30+4,py+(h*23)%30+4,2,2);
      }
      c.fillStyle=`rgba(50,0,100,${0.04+0.03*Math.sin((pw||0)+px*0.02+py*0.02)})`; c.fillRect(px,py,TILE,TILE);
    }
  },
];

function getTheme(lvl) {
  return THEMES[Math.min(Math.floor((lvl - 1) / 3), 6)];
}
