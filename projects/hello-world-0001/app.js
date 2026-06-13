const stage = document.getElementById("stage");
const readout = document.getElementById("readout");
const remixBtn = document.getElementById("remix");
const copyBtn = document.getElementById("copy");

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const hue = () => rand(0, 360);

function remix() {
  const a = hue();
  const b = (a + rand(40, 200)) % 360;
  const angle = rand(0, 360);
  const css = `linear-gradient(${angle}deg, hsl(${a} 80% 62%), hsl(${b} 80% 58%))`;
  stage.style.background = css;
  readout.textContent = css;
}

remixBtn.addEventListener("click", remix);

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(`background: ${readout.textContent};`);
    copyBtn.textContent = "Copied ✓";
    setTimeout(() => (copyBtn.textContent = "Copy CSS"), 1200);
  } catch {
    copyBtn.textContent = "Copy failed";
    setTimeout(() => (copyBtn.textContent = "Copy CSS"), 1200);
  }
});

remix();
