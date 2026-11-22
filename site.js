// The page's only script: copy buttons on code blocks, and the table of contents following the
// section on screen. The page works without it.
const korean = document.documentElement.lang === 'ko'
const words = korean ? { copy: '복사', done: '복사했어요', fail: '선택해서 복사하세요' } : { copy: 'Copy', done: 'Copied', fail: 'Select and copy' }

for (const pre of document.querySelectorAll('main pre')) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'copy'
  button.textContent = words.copy
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector('code')?.innerText ?? pre.innerText)
      button.textContent = words.done
    } catch {
      button.textContent = words.fail
    }
    setTimeout(() => (button.textContent = words.copy), 1500)
  })
  pre.appendChild(button)
}

const links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]))
const headings = [...document.querySelectorAll('main h2[id], main h3[id]')].filter((h) => links.has(h.id))
if (headings.length && 'IntersectionObserver' in window) {
  const visible = new Set()
  const mark = () => {
    const current = headings.find((h) => visible.has(h.id)) ?? null
    if (!current) return
    for (const a of links.values()) a.classList.remove('active')
    links.get(current.id)?.classList.add('active')
  }
  // A heading counts as current while it is in the top third of the window.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id)
        else visible.delete(entry.target.id)
      }
      mark()
    },
    { rootMargin: '0px 0px -70% 0px' }
  )
  headings.forEach((h) => observer.observe(h))
}
