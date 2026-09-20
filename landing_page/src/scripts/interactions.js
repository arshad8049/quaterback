(function () {
  'use strict';

  /* ── Sticky nav blur on scroll ── */
  const nav = document.querySelector('.qb-nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('qb-nav--scrolled', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ── Scroll reveal ── */
  const revealObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('qb-visible');
          revealObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
  );
  document.querySelectorAll('.qb-reveal').forEach((el) => revealObs.observe(el));

  /* ── Auto-reveal section children (no class needed in HTML) ── */
  const sectionDivs = document.querySelectorAll(
    '#problem, #metric, #loop, #verification, #beta, #footer'
  );
  const autoRevealObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          const kids = e.target.querySelectorAll(
            'h2, p, [style*="display: grid"] > div, [style*="display: flex; flex-direction: column; gap"] > div'
          );
          kids.forEach((k, i) => {
            k.style.transitionDelay = i * 0.07 + 's';
            k.classList.add('qb-reveal');
            // Trigger paint, then reveal
            requestAnimationFrame(() => k.classList.add('qb-visible'));
          });
          autoRevealObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.06 }
  );
  sectionDivs.forEach((s) => autoRevealObs.observe(s));

  /* ── Bar animation trigger ── */
  const barObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('qb-bar--run');
          barObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.4 }
  );
  document.querySelectorAll('.qb-bar').forEach((b) => barObs.observe(b));

  /* ── Counter animation ── */
  function animateCount(el, target, duration) {
    const start = performance.now();
    function tick(now) {
      const p = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (eased * target).toFixed(1);
      if (p < 1) requestAnimationFrame(tick);
      else {
        el.textContent = target.toFixed(1);
        el.classList.add('qb-lit');
      }
    }
    requestAnimationFrame(tick);
  }

  const countObs = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          const target = parseFloat(e.target.dataset.target);
          if (!isNaN(target)) animateCount(e.target, target, 1400);
          countObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.6 }
  );

  /* Tag metric numbers with data-target so the counter knows what to count to */
  document.querySelectorAll('.qb-count').forEach((el) => countObs.observe(el));

  /* Auto-detect the four metric numbers by their known values */
  const METRIC_VALS = [7.4, 2.1, 1.4, 0.8];
  document.querySelectorAll('[style*="font-size: 26px"][style*="font-weight: 600"]').forEach((el) => {
    const v = parseFloat(el.textContent);
    if (METRIC_VALS.includes(v)) {
      el.dataset.target = v;
      el.classList.add('qb-count');
      el.textContent = '0.0';
      countObs.observe(el);
    }
  });

  /* ── Terminal cursor ── */
  const terminalCmd = document.querySelector('[style*="color: #6FBF9F"]');
  if (terminalCmd && terminalCmd.textContent.trim().startsWith('$')) {
    terminalCmd.classList.add('qb-cursor');
  }

  /* ── Card hover class injection ── */
  /* Cards are divs with a specific border + background pattern */
  document.querySelectorAll(
    '[style*="background: #121615"][style*="border: 1px solid #262E2B"]'
  ).forEach((el) => el.classList.add('qb-card'));

  /* ── Smooth anchor scroll (override default jump on older browsers) ── */
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const id = link.getAttribute('href').slice(1);
      const target = document.getElementById(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  /* ── Gap section X-icon hover tint ── */
  document.querySelectorAll('[style*="background: #0D100F"][style*="padding: 30px 34px"]').forEach((el) => {
    el.style.transition = 'background 0.25s ease';
    el.addEventListener('mouseenter', () => { el.style.background = '#101310'; });
    el.addEventListener('mouseleave', () => { el.style.background = '#0D100F'; });
  });

})();
