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
          // Small delay so batched siblings stagger naturally
          requestAnimationFrame(() => e.target.classList.add('qb-visible'));
          revealObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -48px 0px' }
  );
  document.querySelectorAll('.qb-reveal').forEach((el) => revealObs.observe(el));

  /* ── Auto-reveal section children ── */
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
            // Stagger: 60ms between items, capped at 400ms total delay
            k.style.transitionDelay = Math.min(i * 0.06, 0.4) + 's';
            k.classList.add('qb-reveal');
            requestAnimationFrame(() => requestAnimationFrame(() => k.classList.add('qb-visible')));
          });
          autoRevealObs.unobserve(e.target);
        }
      });
    },
    { threshold: 0.05 }
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

  /* ── GitHub star count (live fetch, silent fail) ── */
  const starEl = document.getElementById('qb-stars');
  if (starEl) {
    fetch('https://api.github.com/repos/arshad8049/quaterback', {
      headers: { 'Accept': 'application/vnd.github.v3+json' }
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && typeof data.stargazers_count === 'number') {
          const n = data.stargazers_count;
          starEl.textContent = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
        }
      })
      .catch(() => {});
  }

  /* ── GitHub link hover ── */
  const ghLink = document.querySelector('.qb-github-link');
  if (ghLink) {
    ghLink.addEventListener('mouseenter', () => {
      ghLink.style.borderColor = '#4A5C56';
      ghLink.style.color = '#C6CFCB';
    });
    ghLink.addEventListener('mouseleave', () => {
      ghLink.style.borderColor = '#2E3C38';
      ghLink.style.color = '#8A948F';
    });
  }


  /* ── Hamburger nav toggle ── */
  const navToggle = document.querySelector('.qb-nav-toggle');
  const navEl = document.querySelector('.qb-nav');
  if (navToggle && navEl) {
    navToggle.addEventListener('click', () => {
      const isOpen = navEl.classList.toggle('qb-nav-open');
      navToggle.setAttribute('aria-expanded', String(isOpen));
      document.body.style.overflow = isOpen ? 'hidden' : '';
    });
    navEl.querySelectorAll('.qb-nav-link, .qb-cta-btn').forEach((link) => {
      link.addEventListener('click', () => {
        navEl.classList.remove('qb-nav-open');
        navToggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
      });
    });
  }

  /* ── Beta form submission ── */
  const betaForm = document.getElementById('beta-form');
  if (betaForm) {
    betaForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = betaForm.querySelector('button[type="submit"]');
      const emailVal = betaForm.querySelector('[name="email"]').value.trim();
      const agentVal = (betaForm.querySelector('[name="agent"]') || {}).value || '';
      const originalText = btn.textContent;
      btn.textContent = 'Sending…';
      btn.disabled = true;

      let sent = false;
      try {
        const res = await fetch('/api/beta-access', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: emailVal, agent: agentVal }),
        });
        sent = res.ok;
      } catch (_) {}

      if (sent) {
        betaForm.innerHTML =
          '<div style="text-align:center;padding:48px 0;font-family:\'IBM Plex Mono\',monospace;font-size:15px;color:#6FBF9F;letter-spacing:0.06em;">✓ request received<br><span style="font-size:13px;color:#8A948F;letter-spacing:0.04em;display:block;margin-top:12px;">we\'ll be in touch</span></div>';
        return;
      }

      // Fallback: open email client
      const subject = encodeURIComponent('Quarterback Beta Access');
      const body = encodeURIComponent(`Email: ${emailVal}\nAgent: ${agentVal || 'not specified'}`);
      window.open(`mailto:ashaik8.us@gmail.com?subject=${subject}&body=${body}`);
      btn.textContent = originalText;
      btn.disabled = false;
      const fb = document.getElementById('form-feedback');
      if (fb) fb.textContent = 'Opening your email client — thanks for applying!';
    });
  }

})();
