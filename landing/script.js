(() => {
  "use strict";

  /* ------------------------------ mobile nav ------------------------------ */
  const navToggle = document.getElementById("navToggle");
  const mobileMenu = document.getElementById("mobileMenu");
  if (navToggle && mobileMenu) {
    navToggle.addEventListener("click", () => {
      const open = mobileMenu.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    mobileMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        mobileMenu.classList.remove("open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* ------------------------------ scroll reveal ----------------------------- */
  const revealTargets = document.querySelectorAll(
    ".reveal, .step, .feature-card, .mock-shell, .proof-frame"
  );
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );
  revealTargets.forEach((el) => revealObserver.observe(el));

  /* --------------------------- feature card mouse glow --------------------------- */
  document.querySelectorAll(".feature-card").forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - rect.left}px`);
      card.style.setProperty("--my", `${e.clientY - rect.top}px`);
    });
  });

  /* ------------------------------ stat counters ------------------------------ */
  function animateCount(el) {
    const target = parseInt(el.dataset.countTo, 10) || 0;
    const duration = 900;
    const start = performance.now();
    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ------------------------------- mock log typer ------------------------------ */
  const LOG_LINES = [
    { text: "> beacon scan D:\\Code", prompt: true },
    { text: "found 44 projects in 0.6s", prompt: false },
    { text: "> ai-code-reviewer@0.1.0 dev", prompt: true },
    { text: "▲ Next.js 16.2.7 (Turbopack)", prompt: false },
    { text: "- Local:  http://localhost:3000", prompt: false },
    { text: "✓ Ready in 3.1s", prompt: false },
  ];

  function typeLogLoop(logEl) {
    let lineIndex = 0;
    let charIndex = 0;
    let lineEls = [];

    function newLine(isPrompt) {
      const div = document.createElement("div");
      if (isPrompt) div.innerHTML = '<span class="prompt"></span>';
      logEl.appendChild(div);
      lineEls.push(div);
      while (logEl.children.length > 6) {
        logEl.removeChild(logEl.firstChild);
      }
      return div;
    }

    let currentLineEl = null;

    function step() {
      const line = LOG_LINES[lineIndex];
      if (charIndex === 0) {
        currentLineEl = newLine(line.prompt);
      }
      const target = line.prompt
        ? currentLineEl.querySelector(".prompt")
        : currentLineEl;
      charIndex++;
      target.textContent = line.text.slice(0, charIndex);
      target.innerHTML += '<span class="caret"></span>';

      if (charIndex < line.text.length) {
        setTimeout(step, 18 + Math.random() * 22);
      } else {
        target.querySelector(".caret")?.remove();
        charIndex = 0;
        lineIndex = (lineIndex + 1) % LOG_LINES.length;
        setTimeout(step, lineIndex === 0 ? 1400 : 380);
      }
    }
    step();
  }

  const dashboard = document.getElementById("dashboard");
  const mockLog = document.getElementById("mockLog");
  let bootStarted = false;

  const dashObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !bootStarted) {
          bootStarted = true;
          document
            .querySelectorAll("[data-count-to]")
            .forEach((el) => animateCount(el));
          if (mockLog) typeLogLoop(mockLog);
          dashObserver.disconnect();
        }
      });
    },
    { threshold: 0.3 }
  );
  if (dashboard) dashObserver.observe(dashboard);
})();
