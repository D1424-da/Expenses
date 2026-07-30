(function() {
  var slides = document.querySelectorAll('#heroSlides .slide');
  var dots = document.querySelectorAll('.slide-dot');
  if (!slides.length) return;
  var current = 0;
  var timer;

  function goTo(n) {
    slides[current].classList.remove('active');
    slides[current].classList.add('exit');
    dots[current].classList.remove('active');
    var prev = current;
    current = n;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    setTimeout(function() { slides[prev].classList.remove('exit'); }, 500);
  }

  function next() { goTo((current + 1) % slides.length); }

  function start() { timer = setInterval(next, 3500); }
  function stop() { clearInterval(timer); }

  dots.forEach(function(dot, i) {
    dot.addEventListener('click', function() { stop(); goTo(i); start(); });
  });

  start();
})();
