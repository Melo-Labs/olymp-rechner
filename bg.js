(function(){
  var bg=document.createElement('div');bg.className='bg';bg.setAttribute('aria-hidden','true');
  bg.innerHTML='<div class="aurora"><i></i><i></i><i></i></div><div class="dots"></div><canvas id="net"></canvas><div class="vignette"></div>';
  document.body.insertBefore(bg,document.body.firstChild);
})();

(function(){
  var key='olymp-fps-saver';
  var isFpsSaver = localStorage.getItem(key) === '1';
  document.body.classList.toggle('fps-saver', isFpsSaver);
  var toggle = document.getElementById('fps-saver-toggle');
  if (toggle) {
    toggle.checked = isFpsSaver;
    toggle.addEventListener('change', function(){
      var enabled = toggle.checked;
      localStorage.setItem(key, enabled ? '1' : '0');
      document.body.classList.toggle('fps-saver', enabled);
      window.dispatchEvent(new CustomEvent('olymp-fps-saver-change', { detail: { enabled: enabled } }));
    });
  }
})();

if(matchMedia('(hover:hover) and (prefers-reduced-motion:no-preference)').matches && !document.body.classList.contains('fps-saver')){
  document.querySelectorAll('.panel').forEach(function(p){
    p.addEventListener('pointermove',function(e){
      var r=p.getBoundingClientRect();
      var x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
      p.style.setProperty('--ry',(x*8).toFixed(2)+'deg');
      p.style.setProperty('--rx',(-y*8).toFixed(2)+'deg');
    });
    p.addEventListener('pointerleave',function(){
      p.style.setProperty('--rx','0deg');p.style.setProperty('--ry','0deg');
    });
  });
}


(function(){
  var c=document.getElementById('net'),x=c.getContext('2d'),dpr=Math.min(devicePixelRatio||1,2),W,H,P=[],m={x:-999,y:-999};
  var calm = matchMedia('(prefers-reduced-motion:reduce)').matches || localStorage.getItem('olymp-fps-saver') === '1';
  function size(){
    W=innerWidth;H=innerHeight;c.width=W*dpr;c.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0);
    var n=Math.min(110,Math.floor(W*H/14000));P=[];
    for(var i=0;i<n;i++)P.push({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.28,vy:(Math.random()-.5)*.28,r:Math.random()*1.4+.6,h:Math.random()<.55?'214,219,226':'168,158,146'});
  }
  function frame(){
    x.clearRect(0,0,W,H);
    for(var i=0;i<P.length;i++){
      var p=P[i];
      if(!calm){
        p.x+=p.vx;p.y+=p.vy;
        if(p.x<0||p.x>W)p.vx*=-1;
        if(p.y<0||p.y>H)p.vy*=-1;
        var dx=p.x-m.x,dy=p.y-m.y,d=dx*dx+dy*dy;
        if(d<22500){var f=(1-d/22500)*.9;p.x+=dx*f*.03;p.y+=dy*f*.03;}
      }
      x.fillStyle='rgba('+p.h+',.85)';x.beginPath();x.arc(p.x,p.y,p.r,0,6.283);x.fill();
      for(var j=i+1;j<P.length;j++){
        var q=P[j],ax=p.x-q.x,ay=p.y-q.y,dd=ax*ax+ay*ay;
        if(dd<16900){x.strokeStyle='rgba('+p.h+','+(.3*(1-dd/16900)).toFixed(3)+')';x.lineWidth=1;x.beginPath();x.moveTo(p.x,p.y);x.lineTo(q.x,q.y);x.stroke();}
      }
    }
    if(!calm)requestAnimationFrame(frame);
  }
  function handleModeChange(){
    calm = matchMedia('(prefers-reduced-motion:reduce)').matches || localStorage.getItem('olymp-fps-saver') === '1';
    if(calm){
      x.clearRect(0,0,W,H);
      return;
    }
    if(!frame._scheduled){
      frame._scheduled = true;
      requestAnimationFrame(frame);
    }
  }
  window.addEventListener('olymp-fps-saver-change', handleModeChange);
  addEventListener('resize',function(){size();if(calm)frame();});
  addEventListener('pointermove',function(e){m.x=e.clientX;m.y=e.clientY;});
  size();frame();
})();
