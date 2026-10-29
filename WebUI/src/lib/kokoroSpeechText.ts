const CURRENCY_WORDS = { $: 'dollars', '£': 'pounds', '€': 'euros' } as const

const SCALED_AMOUNT = /([$£€])\s?(\d[\d,]*(?:\.\d+)?)\s+(thousand|million|billion|trillion)\b/gi

// OpenVINO's C++ misaki port reads "$2.3 billion" as "two dollars and thirty cents billion";
// Python misaki gets it right. Drop once openvino.genai's misaki_cpp/src/en_g2p.cpp is fixed.
export function prepareKokoroText(text: string): string {
  return text.replace(
    SCALED_AMOUNT,
    (_match, symbol: keyof typeof CURRENCY_WORDS, amount: string, scale: string) =>
      `${amount} ${scale} ${CURRENCY_WORDS[symbol]}`,
  )
}
