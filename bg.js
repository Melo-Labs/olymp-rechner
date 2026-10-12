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
  var c=document.getElementById('net');
  if(!c)return;
  var x=c.getContext('2d');
  if(!x)return;
  var dpr=Math.min(devicePixelRatio||1,2),W,H,P=[],m={x:-999,y:-999},frameId=0;
  var linkDistance=130,linkDistanceSquared=linkDistance*linkDistance;
  var calm = matchMedia('(prefers-reduced-motion:reduce)').matches || localStorage.getItem('olymp-fps-saver') === '1';
  function size(){
    W=innerWidth;H=innerHeight;c.width=W*dpr;c.height=H*dpr;x.setTransform(dpr,0,0,dpr,0,0);
    var n=Math.min(110,Math.floor(W*H/14000));P=[];
    for(var i=0;i<n;i++)P.push({x:Math.random()*W,y:Math.random()*H,vx:(Math.random()-.5)*.28,vy:(Math.random()-.5)*.28,r:Math.random()*1.4+.6,h:Math.random()<.55?'214,219,226':'168,158,146'});
  }
  function schedule(){
    if(!frameId&&!calm&&!document.hidden)frameId=requestAnimationFrame(frame);
  }
  function stop(){
    if(frameId)cancelAnimationFrame(frameId);
    frameId=0;
  }
  function frame(){
    frameId=0;
    x.clearRect(0,0,W,H);
    var cells=new Map();
    for(var i=0;i<P.length;i++){
      var p=P[i];
      if(!calm){
        p.x+=p.vx;p.y+=p.vy;
        if(p.x<0||p.x>W)p.vx*=-1;
        if(p.y<0||p.y>H)p.vy*=-1;
        var dx=p.x-m.x,dy=p.y-m.y,d=dx*dx+dy*dy;
        if(d<22500){var f=(1-d/22500)*.9;p.x+=dx*f*.03;p.y+=dy*f*.03;}
      }
      var cellX=Math.floor(p.x/linkDistance),cellY=Math.floor(p.y/linkDistance),cellKey=cellX+','+cellY;
      if(!cells.has(cellKey))cells.set(cellKey,[]);
      cells.get(cellKey).push(i);
    }
    for(var i=0;i<P.length;i++){
      var p=P[i],cellX=Math.floor(p.x/linkDistance),cellY=Math.floor(p.y/linkDistance);
      x.fillStyle='rgba('+p.h+',.85)';x.beginPath();x.arc(p.x,p.y,p.r,0,6.283);x.fill();
      for(var offsetY=-1;offsetY<=1;offsetY++)for(var offsetX=-1;offsetX<=1;offsetX++){
        var neighbors=cells.get((cellX+offsetX)+','+(cellY+offsetY));
        if(!neighbors)continue;
        for(var neighborIndex=0;neighborIndex<neighbors.length;neighborIndex++){
          var j=neighbors[neighborIndex];
          if(j<=i)continue;
          var q=P[j],ax=p.x-q.x,ay=p.y-q.y,dd=ax*ax+ay*ay;
          if(dd<linkDistanceSquared){x.strokeStyle='rgba('+p.h+','+(.3*(1-dd/linkDistanceSquared)).toFixed(3)+')';x.lineWidth=1;x.beginPath();x.moveTo(p.x,p.y);x.lineTo(q.x,q.y);x.stroke();}
        }
      }
    }
    schedule();
  }
  function handleModeChange(){
    calm = matchMedia('(prefers-reduced-motion:reduce)').matches || localStorage.getItem('olymp-fps-saver') === '1';
    if(calm){
      stop();
      x.clearRect(0,0,W,H);
      return;
    }
    schedule();
  }
  function handleVisibilityChange(){
    if(document.hidden){stop();return;}
    schedule();
  }
  window.addEventListener('olymp-fps-saver-change', handleModeChange);
  document.addEventListener('visibilitychange',handleVisibilityChange);
  addEventListener('resize',function(){size();if(calm)frame();});
  addEventListener('pointermove',function(e){if(!calm){m.x=e.clientX;m.y=e.clientY;}},{passive:true});
  size();
  if(calm)frame();else schedule();
})();
