import { QuestionType } from "../types";

// ============================================
// ENS Knowledge Base
// ============================================
// Pre-written answers for common ENS questions.
// For "general" questions, we'll use Claude to generate answers.

export const ENS_KNOWLEDGE: Record<Exclude<QuestionType, "general">, string> = {
  pricing: `💰 **ENS Pricing**

The yearly cost depends on the name length:

• **5+ characters:** $5/year
• **4 characters:** $160/year
• **3 characters:** $640/year

Plus you'll pay gas fees for the transaction (varies with network activity).

_Tip: Longer names are much cheaper! A 5-letter name for 10 years costs only $50 + gas._`,

  duration: `📅 **ENS Registration Duration**

• **Minimum:** 1 year
• **Maximum:** No limit! (but most interfaces cap at 10 years)

**Good to know:**
• You can renew anytime — even before expiration
• After expiration, there's a 90-day grace period where only you can renew
• After the grace period, the name goes to auction

_Tip: Registering for multiple years saves on gas fees since you only pay once!_`,

  records: `📋 **ENS Records**

You can store lots of info on your ENS name:

**Addresses:**
• ETH address (for receiving payments)
• BTC, LTC, and other crypto addresses

**Profile Info:**
• Twitter/X handle
• GitHub username
• Email address
• Website URL
• Avatar (image URL or NFT)
• Description/bio

**Advanced:**
• Content hash (for IPFS websites)
• Custom text records

_Your ENS name becomes your web3 identity!_`,

  process: `🔄 **How ENS Registration Works**

It's a 3-step process:

**Step 1: Commit (hidden)**
Your intent to register is recorded on-chain, but the name is hidden. This prevents others from front-running you.

**Step 2: Wait (~1 minute)**
A short waiting period ensures your commitment is secure.

**Step 3: Register**
Complete the registration and the name is yours!

**What you'll need:**
• ETH for the registration fee + gas
• A wallet (like MetaMask or Towns wallet)

_The whole process takes about 2-3 minutes!_`,
};

// ============================================
// Get Answer for Question
// ============================================

/**
 * Returns a pre-written answer for known question types,
 * or null for "general" questions (which need Claude to answer).
 */
export function getKnowledgeAnswer(questionType: QuestionType): string | null {
  if (questionType === "general") {
    return null; // Will be handled by Claude
  }

  return ENS_KNOWLEDGE[questionType] || null;
}

// ============================================
// General Question Prompt
// ============================================
// Used when questionType is "general" and we need Claude to answer

export const GENERAL_QUESTION_PROMPT = `You are Coco, a friendly ENS (Ethereum Name Service) assistant.

Answer the user's question about ENS in a helpful, concise way.

RULES:
1. Be friendly and conversational
2. Use simple language (explain like they're new to crypto)
3. Use emojis sparingly (2-3 max)
4. Keep answers under 150 words
5. If you're not sure, say so and suggest where they can learn more
6. Focus only on ENS-related topics

CONTEXT ABOUT ENS:
- ENS is like DNS for Ethereum - human-readable names for crypto addresses
- Names end in .eth (e.g., alice.eth)
- You can send crypto to alice.eth instead of 0x742d35Cc...
- Names can store profile info (twitter, avatar, etc.)
- Names are NFTs - you can buy, sell, transfer them
- Registration requires ETH for fees + gas

USER QUESTION: "{{question}}"

Answer naturally and helpfully:`;
