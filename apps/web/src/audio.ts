// Web Audio API para feedback sonoro imediato no scanner HID e mobile
// Conforme Capítulo 08 & 09 da especificação New Life

let audioCtx: AudioContext | undefined

export function getAudioContext(): AudioContext | undefined {
  try {
    if (!audioCtx && typeof window !== 'undefined' && 'AudioContext' in window) {
      audioCtx = new AudioContext()
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      void audioCtx.resume().catch(() => {})
    }
    return audioCtx
  } catch {
    return undefined
  }
}

export function playSound(type: 'MATCHED' | 'DUPLICATE' | 'UNKNOWN' | 'ERROR' | 'SHUTTER'): void {
  const ctx = getAudioContext()
  if (!ctx || ctx.state !== 'running') return

  const now = ctx.currentTime

  if (type === 'MATCHED') {
    // Tom límpido ascendente de sucesso (880Hz -> 1320Hz)
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()

    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(880, now)
    osc1.frequency.exponentialRampToValueAtTime(1320, now + 0.12)

    osc2.type = 'triangle'
    osc2.frequency.setValueAtTime(440, now)

    gain.gain.setValueAtTime(0.12, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)

    osc1.connect(gain)
    osc2.connect(gain)
    gain.connect(ctx.destination)

    osc1.start(now)
    osc2.start(now)
    osc1.stop(now + 0.19)
    osc2.stop(now + 0.19)
  } else if (type === 'DUPLICATE') {
    // Tom de aviso duplo suave (520Hz)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'triangle'
    osc.frequency.setValueAtTime(520, now)
    osc.frequency.setValueAtTime(480, now + 0.08)

    gain.gain.setValueAtTime(0.1, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.23)
  } else if (type === 'UNKNOWN') {
    // Tom oco de código desconhecido (350Hz)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(350, now)
    osc.frequency.exponentialRampToValueAtTime(260, now + 0.2)

    gain.gain.setValueAtTime(0.08, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.23)
  } else if (type === 'ERROR') {
    // Alerta sonoro grave de divergência/falha (220Hz -> 180Hz)
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'square'
    osc.frequency.setValueAtTime(220, now)
    osc.frequency.setValueAtTime(180, now + 0.1)

    gain.gain.setValueAtTime(0.09, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.29)
  } else if (type === 'SHUTTER') {
    // Som suave de clique de obturador de câmera
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(1200, now)
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.05)

    gain.gain.setValueAtTime(0.15, now)
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.07)
  }
}
