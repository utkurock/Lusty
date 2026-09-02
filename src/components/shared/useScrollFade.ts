'use client'
import { RefObject, useEffect } from 'react'

/**
 * Drive the `.scroll-fade-y` mask from where the container actually is.
 *
 * A static edge fade is wrong at the ends of a list: it dims the first item
 * before you have scrolled at all, and the last one once you have arrived,
 * which is the opposite of what the fade is for. This sets each band to 0 at
 * the end that has been reached, so the fade only ever means "there is more
 * this way".
 *
 * Cheap enough to run on every scroll frame: two reads off the element and a
 * custom-property write, no layout of our own.
 */
export function useScrollFade(ref: RefObject<HTMLElement>, band = 24) {
  useEffect(() => {
    const el = ref.current
    if (!el) return

    const update = () => {
      const max = el.scrollHeight - el.clientHeight
      // Not scrollable: no fade at either end.
      if (max <= 1) {
        el.style.setProperty('--fade-top', '0px')
        el.style.setProperty('--fade-bottom', '0px')
        return
      }
      const top = Math.min(band, el.scrollTop)
      const bottom = Math.min(band, max - el.scrollTop)
      el.style.setProperty('--fade-top', `${top}px`)
      el.style.setProperty('--fade-bottom', `${bottom}px`)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    // The list can change height without scrolling — a section opens, the
    // window resizes, the font finally loads.
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [ref, band])
}
