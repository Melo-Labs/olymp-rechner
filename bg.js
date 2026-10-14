(function(){
  var background = document.createElement('div');
  background.className = 'bg';
  background.setAttribute('aria-hidden', 'true');
  background.innerHTML = '<div class="aurora"><i></i><i></i><i></i></div><div class="dots"></div><canvas id="net"></canvas><div class="vignette"></div>';
  document.body.insertBefore(background, document.body.firstChild);
})();

(function(){
  var key = 'olymp-fps-saver';
  var toggle = document.getElementById('fps-saver-toggle');

  function getFpsPreference(){
    try { return localStorage.getItem(key) === '1'; }
    catch (error) { return false; }
  }

  function setFpsPreference(enabled){
    try { localStorage.setItem(key, enabled ? '1' : '0'); }
    catch (error) { /* The current-page preference still applies if storage is unavailable. */ }
  }

  function applyFpsPreference(enabled, notify){
    document.body.classList.toggle('fps-saver', enabled);
    if (toggle && toggle.checked !== enabled) toggle.checked = enabled;
    if (notify) {
      window.dispatchEvent(new CustomEvent('olymp-fps-saver-change', { detail: { enabled: enabled } }));
    }
  }

  applyFpsPreference(getFpsPreference(), false);
  if (toggle) {
    toggle.addEventListener('change', function(){
      var enabled = toggle.checked;
      setFpsPreference(enabled);
      applyFpsPreference(enabled, true);
    });
  }
})();

(function(){
  var reducedMotion = matchMedia('(prefers-reduced-motion:reduce)');
  var fpsPreferenceKey = 'olymp-fps-saver';
  var calm = reducedMotion.matches || document.body.classList.contains('fps-saver');

  if (matchMedia('(hover:hover)').matches) {
    document.querySelectorAll('.panel').forEach(function(panel){
      panel.addEventListener('pointermove', function(event){
        if (calm) return;
        var rect = panel.getBoundingClientRect();
        var x = (event.clientX - rect.left) / rect.width - .5;
        var y = (event.clientY - rect.top) / rect.height - .5;
        panel.style.setProperty('--ry', (x * 8).toFixed(2) + 'deg');
        panel.style.setProperty('--rx', (-y * 8).toFixed(2) + 'deg');
      });
      panel.addEventListener('pointerleave', function(){
        panel.style.setProperty('--rx', '0deg');
        panel.style.setProperty('--ry', '0deg');
      });
    });
  }

  var canvas = document.getElementById('net');
  if (!canvas) return;
  var context = canvas.getContext('2d');
  if (!context) return;

  var dpr = Math.min(devicePixelRatio || 1, 2);
  var width;
  var height;
  var points = [];
  var mouse = { x: -999, y: -999 };
  var frameId = 0;
  var linkDistance = 130;
  var linkDistanceSquared = linkDistance * linkDistance;

  function isMotionRestricted(){
    var fpsRestricted = document.body.classList.contains('fps-saver');
    try { fpsRestricted = fpsRestricted || localStorage.getItem(fpsPreferenceKey) === '1'; }
    catch (error) { /* Fall back to the body class when storage is unavailable. */ }
    return fpsRestricted || reducedMotion.matches;
  }

  calm = isMotionRestricted();

  function size(){
    width = innerWidth;
    height = innerHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    var count = Math.min(110, Math.floor(width * height / 14000));
    points = [];
    for (var i = 0; i < count; i++) {
      points.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - .5) * .28,
        vy: (Math.random() - .5) * .28,
        radius: Math.random() * 1.4 + .6,
        hue: Math.random() < .55 ? '214,219,226' : '168,158,146'
      });
    }
  }

  function schedule(){
    if (!frameId && !calm && !document.hidden) frameId = requestAnimationFrame(draw);
  }

  function stop(){
    if (frameId) cancelAnimationFrame(frameId);
    frameId = 0;
  }

  function draw(){
    frameId = 0;
    context.clearRect(0, 0, width, height);
    var cells = new Map();

    for (var i = 0; i < points.length; i++) {
      var point = points[i];
      if (!calm) {
        point.x += point.vx;
        point.y += point.vy;
        if (point.x < 0 || point.x > width) point.vx *= -1;
        if (point.y < 0 || point.y > height) point.vy *= -1;
        var dx = point.x - mouse.x;
        var dy = point.y - mouse.y;
        var distance = dx * dx + dy * dy;
        if (distance < 22500) {
          var force = (1 - distance / 22500) * .9;
          point.x += dx * force * .03;
          point.y += dy * force * .03;
        }
      }
      var cellX = Math.floor(point.x / linkDistance);
      var cellY = Math.floor(point.y / linkDistance);
      var cellKey = cellX + ',' + cellY;
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push(i);
    }

    for (var index = 0; index < points.length; index++) {
      var current = points[index];
      var currentCellX = Math.floor(current.x / linkDistance);
      var currentCellY = Math.floor(current.y / linkDistance);
      context.fillStyle = 'rgba(' + current.hue + ',.85)';
      context.beginPath();
      context.arc(current.x, current.y, current.radius, 0, 6.283);
      context.fill();

      for (var offsetY = -1; offsetY <= 1; offsetY++) {
        for (var offsetX = -1; offsetX <= 1; offsetX++) {
          var neighbors = cells.get((currentCellX + offsetX) + ',' + (currentCellY + offsetY));
          if (!neighbors) continue;
          for (var neighborIndex = 0; neighborIndex < neighbors.length; neighborIndex++) {
            var neighborId = neighbors[neighborIndex];
            if (neighborId <= index) continue;
            var neighbor = points[neighborId];
            var xDistance = current.x - neighbor.x;
            var yDistance = current.y - neighbor.y;
            var squaredDistance = xDistance * xDistance + yDistance * yDistance;
            if (squaredDistance < linkDistanceSquared) {
              context.strokeStyle = 'rgba(' + current.hue + ',' + (.3 * (1 - squaredDistance / linkDistanceSquared)).toFixed(3) + ')';
              context.lineWidth = 1;
              context.beginPath();
              context.moveTo(current.x, current.y);
              context.lineTo(neighbor.x, neighbor.y);
              context.stroke();
            }
          }
        }
      }
    }
    schedule();
  }

  function handleMotionChange(){
    calm = isMotionRestricted();
    if (calm) {
      stop();
      context.clearRect(0, 0, width, height);
      return;
    }
    schedule();
  }

  function handleVisibilityChange(){
    if (document.hidden) {
      stop();
      return;
    }
    schedule();
  }

  window.addEventListener('olymp-fps-saver-change', handleMotionChange);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  if (typeof reducedMotion.addEventListener === 'function') reducedMotion.addEventListener('change', handleMotionChange);
  else if (typeof reducedMotion.addListener === 'function') reducedMotion.addListener(handleMotionChange);
  addEventListener('resize', function(){
    size();
    if (calm) {
      context.clearRect(0, 0, width, height);
      return;
    }
    schedule();
  });
  addEventListener('pointermove', function(event){
    if (!calm) {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
    }
  }, { passive: true });

  size();
  if (calm) draw();
  else schedule();
})();
