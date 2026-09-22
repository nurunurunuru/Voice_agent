// server/liveSession.js
// Browser <--WS--> Node.js Server <--WS--> Gemini Live API
//
// Features:
// - Realtime voice conversation
// - Website RAG
// - Gemini embeddings
// - User transcript
// - AI transcript
// - Audio streaming
// - Bengali initial welcome greeting
// - Website-name based greeting
// - Representative-name based greeting
// - Customer-language based responses after greeting
// - Authoritative phone/email/address
// - Hotline fallback when website information is unavailable
// - 8-second silence follow-up
// - 5-second timeout after follow-up question
// - Automatic cleanup

const WebSocket = require("ws");
const { embedText } = require("./embeddings");
const vectorStore = require("./vectorStore");
const leads = require("./leads");

const GEMINI_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const SEARCH_TOOL_NAME = "search_website_info";

// ============================================================
// GEMINI LIVE SETUP
// ============================================================

function buildSetupMessage({ model, systemPrompt }) {
  return {
    setup: {
      model: `models/${model}`,

      generationConfig: {
        responseModalities: ["AUDIO"],

        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Aoede",
            },
          },
        },
      },

      inputAudioTranscription: {},

      outputAudioTranscription: {},

      systemInstruction: {
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },

      tools: [
        {
          functionDeclarations: [
            {
              name: SEARCH_TOOL_NAME,

              description:
                "Search the trained website information for website-specific questions such as services, products, pricing, policies, FAQs, features, or other website content. Do NOT use this tool for phone number, email address, or business address; those are provided separately as authoritative contact information. Never invent website information.",

              parameters: {
                type: "OBJECT",

                properties: {
                  query: {
                    type: "STRING",

                    description:
                      "The main topic, keyword, or question to search in the trained website information.",
                  },
                },

                required: ["query"],
              },
            },
          ],
        },
      ],

      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
        },
      },
    },
  };
}

// ============================================================
// INITIAL BENGALI GREETING
// ============================================================

function buildGreetingInstruction(siteName, representativeName) {
  return `
You must greet the customer now.

IMPORTANT RULES FOR THIS FIRST GREETING:

1. The greeting MUST be entirely in Bengali.
2. The representative's name MUST be exactly "${representativeName}".
3. Mention the website name exactly as "${siteName}".
4. Keep the greeting short.
5. Keep it warm, professional, friendly, and natural.
6. Do not answer any question yet.
7. Do not use the website search tool for the greeting.
8. Do not add any extra sentence before or after the greeting.
9. Do not change, replace, translate, shorten, or omit the representative's name.
10. Do not say any English welcome sentence before the Bengali greeting.

Website name:
"${siteName}"

Representative name:
"${representativeName}"

Say exactly:

"আসসালামু আলাইকুম। ${siteName}-এর Customer Support থেকে ${representativeName} বলছি। আপনাকে কীভাবে সহযোগিতা করতে পারি?"

Do not say anything else.
`.trim();
}

// ============================================================
// START GEMINI BRIDGE
// ============================================================

async function startBridge(browserWs, opts) {
  const {
    agentId,
    apiKey,
    model,
    customerName,
    customerPhone,
    customerEmail,
  } = opts;

  // ==========================================================
  // TRANSCRIPT
  // ==========================================================

  const transcriptLog = [];

  function pushTranscriptChunk(role, chunk) {
    const text = String(chunk || "").trim();

    if (!text) return;

    const last = transcriptLog[transcriptLog.length - 1];

    if (last && last.role === role) {
      last.text += text;
      last.at = new Date().toISOString();
    } else {
      transcriptLog.push({
        role,
        text,
        at: new Date().toISOString(),
      });
    }
  }

  console.log("");
  console.log("=================================");
  console.log("📞 Starting Voice Agent Bridge");
  console.log("Agent ID:", agentId);
  console.log("Model:", model);
  console.log("=================================");

  // ==========================================================
  // LOAD TRAINED AGENT
  // ==========================================================

  const agentStore = await vectorStore.loadStore(agentId);

  if (!agentStore) {
    console.error("❌ Agent store not found:", agentId);

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "error",
          message:
            "এই agentId এর জন্য কোনো training data পাওয়া যায়নি। আগে /api/train কল করুন।",
        })
      );

      browserWs.close();
    }

    return;
  }

  console.log(`✅ Agent loaded: ${agentStore.siteName}`);

  // ==========================================================
  // AGENT IDENTITY
  // ==========================================================

  const representativeName =
    agentStore.representativeName || "Faysal Amin";

  const siteName =
    agentStore.siteName || "আমাদের প্রতিষ্ঠান";

  // ==========================================================
  // AUTHORITATIVE CONTACT INFORMATION
  // ==========================================================

  const contactInfo = agentStore.contactInfo || {};

  const phone = String(contactInfo.phone || "").trim();
  const email = String(contactInfo.email || "").trim();
  const address = String(contactInfo.address || "").trim();

  console.log("👤 Representative:", representativeName);
  console.log("🌐 Site:", siteName);
  console.log("📞 Phone:", phone || "<not configured>");
  console.log("📧 Email:", email || "<not configured>");
  console.log("📍 Address:", address || "<not configured>");

  // ==========================================================
  // BASE SYSTEM PROMPT
  // ==========================================================

  const baseSystemPrompt = `
You are "${representativeName}", the helpful customer support representative for "${siteName}".

==================================================
IDENTITY RULES
==================================================

- Your name is EXACTLY "${representativeName}".
- Never say your name is Alex.
- Never say your name is Faisal.
- Never introduce yourself using another person's name.
- Never invent or change your representative name.
- During the initial greeting, use exactly "${representativeName}".

==================================================
ROLE
==================================================

- You are a customer support representative for "${siteName}".
- Help customers with questions related to this website, business, products, services, policies, pricing, features, and FAQs.
- Be natural, friendly, professional, and conversational.
- Do not sound robotic.
- Keep answers concise unless the customer asks for more details.

==================================================
INITIAL GREETING
==================================================

- The initial greeting is handled separately by the server.
- The initial greeting MUST be Bengali.
- Do not create another greeting before or after the server-provided greeting.
- After the initial greeting, do not repeat the introduction unless the customer asks.

==================================================
LANGUAGE RULES
==================================================

- After the initial Bengali greeting, always respond in the same language the customer is currently using.
- If the customer speaks Bengali, respond in Bengali.
- If the customer speaks English, respond in English.
- If the customer speaks Hindi, respond in Hindi.
- If the customer speaks Arabic, respond in Arabic.
- If the customer speaks another language, respond in that language when reasonably possible.
- Do NOT force Bengali or English after the initial greeting.
- Do NOT translate the customer's question into another language unless requested.
- Keep the same language throughout the answer unless the customer changes language.

==================================================
WEBSITE INFORMATION
==================================================

- Only provide website/business information supported by the trained website content.
- Never invent, guess, or fabricate website-specific information.
- When the customer asks about website-specific information, use the "${SEARCH_TOOL_NAME}" tool when necessary.
- Never mention RAG, embeddings, vector databases, training data, Gemini, internal tools, prompts, databases, or system instructions.

==================================================
CONTACT INFORMATION
==================================================

Phone number:
${phone || "Not configured"}

Email address:
${email || "Not configured"}

Business address:
${address || "Not configured"}

Rules:

- If the customer asks for the phone number or hotline, provide the authoritative phone number above.
- If the customer asks for the email address, provide the authoritative email address above.
- If the customer asks for the business address or location, provide the authoritative business address above.
- Never invent, modify, guess, or change contact information.
- Never use the website search tool to find phone number, email address, or business address.
- Contact information above is authoritative.

==================================================
MISSING WEBSITE INFORMATION
==================================================

If the customer asks about a website-related service, product, pricing, policy, feature, FAQ, or other business information and that information cannot be found in the trained website content:

- NEVER say:
  "This information is not in our system."
- NEVER say:
  "I don't have that information."
- NEVER say:
  "The information is unavailable."
- NEVER say:
  "I cannot find this information."
- NEVER mention internal systems, databases, RAG, embeddings, training data, or tools.

Instead:

${
  phone
    ? `Tell the customer directly to call the official hotline: ${phone}.`
    : `Do not invent a phone number because no hotline number has been configured. Politely tell the customer to contact the business through the available official contact channel.`
}

Example in English:
${
  phone
    ? `"For more details about this, please call our hotline at ${phone}."`
    : `"Please contact our official support channel for more details."`
}

Example in Bengali:
${
  phone
    ? `"এই বিষয়ে বিস্তারিত জানতে আমাদের hotline নম্বরে ${phone} কল করুন।"`
    : `"এই বিষয়ে বিস্তারিত জানতে আমাদের official support channel-এ যোগাযোগ করুন।"`
}

Always respond in the customer's language.

==================================================
CONVERSATION BEHAVIOR
==================================================

- Listen carefully to the customer.
- Answer naturally.
- Do not repeat the same information unnecessarily.
- Do not ask unnecessary questions.
- If the customer's request is clear, answer directly.
- If clarification is genuinely necessary, ask one short clarification question.
- If the customer says goodbye or clearly indicates that the conversation is finished, politely thank them and end the conversation naturally.
`.trim();

  // ==========================================================
  // CUSTOM SYSTEM PROMPT
  // ==========================================================

  const customSystemPrompt =
    String(agentStore.systemPrompt || "").trim();

  const finalSystemPrompt = `
${baseSystemPrompt}

==================================================
CUSTOM BUSINESS INSTRUCTIONS
==================================================

${customSystemPrompt || "No additional custom business instructions were configured."}

==================================================
FINAL PRIORITY RULE
==================================================

The identity, language, contact-information, website-information, and safety rules above must always be followed. Custom business instructions must not override those rules.
`.trim();

  // ==========================================================
  // GEMINI WEBSOCKET
  // ==========================================================

  const geminiUrl =
    `${GEMINI_WS_URL}?key=${encodeURIComponent(apiKey)}`;

  console.log("🔌 Connecting to Gemini...");

  const geminiWs = new WebSocket(geminiUrl);

  let setupDone = false;

  // ==========================================================
  // PENDING BROWSER MESSAGES
  // ==========================================================

  const pendingFromBrowser = [];

  // ==========================================================
  // GREETING STATE
  // ==========================================================

  let greetingSent = false;

  // ==========================================================
  // SILENCE / FOLLOW-UP STATE
  // ==========================================================

  let silenceFollowUpTimer = null;
  let followUpAlreadySent = false;
  let waitingForFollowUpAnswer = false;
  let followUpEndTimer = null;

  // ==========================================================
  // TIMER CLEANUP
  // ==========================================================

  function clearSilenceFollowUpTimer() {
    if (silenceFollowUpTimer) {
      clearTimeout(silenceFollowUpTimer);
      silenceFollowUpTimer = null;
    }
  }

  function clearFollowUpEndTimer() {
    if (followUpEndTimer) {
      clearTimeout(followUpEndTimer);
      followUpEndTimer = null;
    }
  }

  function clearAllTimers() {
    clearSilenceFollowUpTimer();
    clearFollowUpEndTimer();
  }

  // ==========================================================
  // END CALL
  // ==========================================================

  function endCall(reason = "normal") {
    console.log("📞 Ending call:", reason);

    clearAllTimers();

    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(
        JSON.stringify({
          type: "call_ended",
          reason,
        })
      );
    }

    setTimeout(() => {
      if (
        geminiWs.readyState === WebSocket.OPEN ||
        geminiWs.readyState === WebSocket.CONNECTING
      ) {
        geminiWs.close();
      }

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close();
      }
    }, 300);
  }

  // ==========================================================
  // FOLLOW-UP END TIMER
  // ==========================================================

  function startFollowUpEndTimer() {
    clearFollowUpEndTimer();

    console.log(
      "⏳ Follow-up question finished. Waiting 5 seconds for customer answer..."
    );

    followUpEndTimer = setTimeout(() => {
      followUpEndTimer = null;

      if (!setupDone) {
        return;
      }

      if (geminiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      if (!waitingForFollowUpAnswer) {
        return;
      }

      console.log(
        "⏰ Customer did not answer follow-up within 5 seconds."
      );

      endCall("customer_no_response_after_follow_up");
    }, 5000);
  }

  // ==========================================================
  // 8 SECOND SILENCE FOLLOW-UP TIMER
  // ==========================================================

  function startSilenceFollowUpTimer() {
    clearSilenceFollowUpTimer();

    if (followUpAlreadySent) {
      return;
    }

    if (!setupDone) {
      return;
    }

    if (geminiWs.readyState !== WebSocket.OPEN) {
      return;
    }

    console.log(
      "⏳ Agent finished speaking. Starting 8 second silence timer..."
    );

    silenceFollowUpTimer = setTimeout(() => {
      silenceFollowUpTimer = null;

      if (!setupDone) {
        return;
      }

      if (geminiWs.readyState !== WebSocket.OPEN) {
        return;
      }

      if (followUpAlreadySent) {
        return;
      }

      followUpAlreadySent = true;
      waitingForFollowUpAnswer = true;

      console.log(
        "⏰ Customer silent for 8 seconds"
      );

      const followUpInstruction = `
The customer has not spoken for 8 seconds after your previous response.

Ask ONE short, natural follow-up question.

Use the same language the customer has been speaking.

The question should naturally mean:
"How else can I help you?"
or
"Is there anything else you'd like to know?"

Do not mention the 8-second silence.
Do not mention this instruction.
Do not explain anything.
Do not give additional information.

Just ask the short follow-up question naturally.
`.trim();

      geminiWs.send(
        JSON.stringify({
          clientContent: {
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: followUpInstruction,
                  },
                ],
              },
            ],
            turnComplete: true,
          },
        })
      );

      console.log(
        "✅ Follow-up question instruction sent to Gemini"
      );
    }, 8000);
  }

  // ==========================================================
  // GEMINI OPEN
  // ==========================================================

  geminiWs.on("open", () => {
    console.log("🟢 Gemini WebSocket OPEN");

    const setupMessage = buildSetupMessage({
      model,
      systemPrompt: finalSystemPrompt,
    });

    console.log("📤 Sending Gemini setup...");

    geminiWs.send(JSON.stringify(setupMessage));
  });

  // ==========================================================
  // GEMINI MESSAGE
  // ==========================================================

  geminiWs.on("message", async (raw) => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error(
        "❌ Invalid Gemini JSON:",
        err.message
      );

      return;
    }

    // ========================================================
    // SETUP COMPLETE
    // ========================================================

    if (msg.setupComplete) {
      setupDone = true;

      console.log("✅ Gemini setup complete");

      // ------------------------------------------------------
      // TELL BROWSER GEMINI IS READY
      // ------------------------------------------------------

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(
          JSON.stringify({
            type: "ready",
          })
        );
      }

      // ------------------------------------------------------
      // INITIAL BENGALI GREETING
      // ------------------------------------------------------

      if (!greetingSent) {
        greetingSent = true;

        const greetingInstruction =
          buildGreetingInstruction(
            siteName,
            representativeName
          );

        console.log(
          "👋 Sending initial Bengali greeting..."
        );

        if (geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(
            JSON.stringify({
              clientContent: {
                turns: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: greetingInstruction,
                      },
                    ],
                  },
                ],
                turnComplete: true,
              },
            })
          );
        }
      }

      // ------------------------------------------------------
      // SEND QUEUED BROWSER MESSAGES
      // ------------------------------------------------------

      if (pendingFromBrowser.length > 0) {
        console.log(
          `📨 Sending ${pendingFromBrowser.length} pending messages`
        );

        for (const message of pendingFromBrowser.splice(0)) {
          if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.send(message);
          }
        }
      }

      return;
    }

    // ========================================================
    // GEMINI ERROR
    // ========================================================

    if (msg.error) {
      console.error(
        "❌ Gemini API error:",
        JSON.stringify(msg.error, null, 2)
      );

      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(
          JSON.stringify({
            type: "error",
            message:
              msg.error.message ||
              "Gemini API error",
          })
        );
      }

      return;
    }

    // ========================================================
    // TOOL CALL / RAG
    // ========================================================

    if (
      msg.toolCall &&
      Array.isArray(msg.toolCall.functionCalls)
    ) {
      console.log("🔎 Gemini requested tool call");

      const responses = [];

      for (const call of msg.toolCall.functionCalls) {
        if (call.name !== SEARCH_TOOL_NAME) {
          continue;
        }

        const query =
          String(call.args?.query || "").trim();

        console.log(
          "🔍 Searching website:",
          query
        );

        let resultText =
          "কোনো প্রাসঙ্গিক তথ্য পাওয়া যায়নি।";

        try {
          // --------------------------------------------------
          // CREATE QUERY EMBEDDING
          // --------------------------------------------------

          const qEmbedding =
            await embedText(
              apiKey,
              query
            );

          // --------------------------------------------------
          // VECTOR SEARCH
          // IMPORTANT: vectorStore.search is async
          // --------------------------------------------------

          const top =
            await vectorStore.search(
              agentId,
              qEmbedding,
              4
            );

          if (top && top.length > 0) {
            resultText = top
              .map(
                (chunk, index) =>
                  `[${index + 1}] ${
                    chunk.title ||
                    chunk.url ||
                    "Website content"
                  }\n${chunk.text || ""}`
              )
              .join("\n\n");
          }

          console.log(
            `✅ Found ${top?.length || 0} relevant chunks`
          );
        } catch (err) {
          console.error(
            "❌ Vector search error:",
            err.message
          );

          resultText =
            "ওয়েবসাইটের তথ্য খুঁজতে সমস্যা হয়েছে।";
        }

        // ----------------------------------------------------
        // TOOL RESPONSE
        // ----------------------------------------------------

        responses.push({
          id: call.id,
          name: call.name,
          response: {
            result: resultText,
          },
        });
      }

      // ======================================================
      // SEND TOOL RESPONSE TO GEMINI
      // ======================================================

      if (
        responses.length > 0 &&
        geminiWs.readyState === WebSocket.OPEN
      ) {
        console.log(
          "📤 Sending tool response to Gemini"
        );

        geminiWs.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: responses,
            },
          })
        );
      }

      return;
    }

    // ========================================================
    // GEMINI SERVER CONTENT
    // ========================================================

    if (msg.serverContent) {
      const sc = msg.serverContent;

      // ======================================================
      // USER TRANSCRIPT
      // ======================================================

      if (
        sc.inputTranscription &&
        sc.inputTranscription.text
      ) {
        const userText =
          String(
            sc.inputTranscription.text
          ).trim();

        if (userText) {
          // Customer has spoken.
          // Therefore normal silence timer must stop.
          clearSilenceFollowUpTimer();

          // If we were waiting for an answer to the
          // automatic follow-up question, cancel the
          // 5-second ending timer.
          if (waitingForFollowUpAnswer) {
            console.log(
              "👤 Customer answered the follow-up question"
            );

            clearFollowUpEndTimer();

            waitingForFollowUpAnswer = false;
            followUpAlreadySent = false;
          } else {
            followUpAlreadySent = false;
          }

          console.log(
            "👤 USER:",
            userText
          );

          pushTranscriptChunk(
            "user",
            userText
          );

          if (
            browserWs.readyState === WebSocket.OPEN
          ) {
            browserWs.send(
              JSON.stringify({
                type: "transcript",
                role: "user",
                text: userText,
              })
            );
          }
        }
      }

      // ======================================================
      // AI TRANSCRIPT
      // ======================================================

      if (
        sc.outputTranscription &&
        sc.outputTranscription.text
      ) {
        const assistantText =
          String(
            sc.outputTranscription.text
          ).trim();

        if (assistantText) {
          console.log(
            "🤖 AGENT:",
            assistantText
          );

          pushTranscriptChunk(
            "assistant",
            assistantText
          );

          if (
            browserWs.readyState === WebSocket.OPEN
          ) {
            browserWs.send(
              JSON.stringify({
                type: "transcript",
                role: "assistant",
                text: assistantText,
              })
            );
          }
        }
      }

      // ======================================================
      // AGENT RESPONSE COMPLETE
      // ======================================================

      if (sc.turnComplete) {
        console.log(
          "✅ Agent finished speaking"
        );

        // ----------------------------------------------------
        // FOLLOW-UP QUESTION COMPLETED
        // ----------------------------------------------------

        if (waitingForFollowUpAnswer) {
          console.log(
            "❓ Follow-up question completed"
          );

          startFollowUpEndTimer();
        }

        // ----------------------------------------------------
        // NORMAL RESPONSE COMPLETED
        // ----------------------------------------------------

        else {
          startSilenceFollowUpTimer();
        }
      }

      // ======================================================
      // AUDIO + SERVER CONTENT
      // ======================================================

      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "serverContent",
            data: sc,
          })
        );
      }

      return;
    }

    // ========================================================
    // SESSION RESUMPTION
    // ========================================================

    if (msg.sessionResumptionUpdate) {
      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "sessionResumptionUpdate",
            data: msg.sessionResumptionUpdate,
          })
        );
      }

      return;
    }

    // ========================================================
    // GO AWAY
    // ========================================================

    if (msg.goAway) {
      console.log("⚠️ Gemini sent goAway");

      if (
        browserWs.readyState === WebSocket.OPEN
      ) {
        browserWs.send(
          JSON.stringify({
            type: "goAway",
            data: msg.goAway,
          })
        );
      }

      return;
    }
  });

  // ==========================================================
  // GEMINI CLOSE
  // ==========================================================

  geminiWs.on("close", (code, reason) => {
    console.log("");

    console.log(
      "🔴 Gemini WebSocket CLOSED"
    );

    console.log(
      "Close code:",
      code
    );

    console.log(
      "Close reason:",
      reason?.toString() || "<empty>"
    );

    clearAllTimers();

    if (
      browserWs.readyState === WebSocket.OPEN
    ) {
      browserWs.send(
        JSON.stringify({
          type: "closed",
          code,
          reason:
            reason?.toString() || "",
        })
      );

      browserWs.close();
    }
  });

  // ==========================================================
  // GEMINI ERROR
  // ==========================================================

  geminiWs.on("error", (err) => {
    console.error(
      "❌ Gemini WebSocket error:",
      err.message
    );

    if (
      browserWs.readyState === WebSocket.OPEN
    ) {
      browserWs.send(
        JSON.stringify({
          type: "error",
          message:
            "Voice service error: " +
            err.message,
        })
      );
    }
  });

  // ==========================================================
  // BROWSER MESSAGE
  // ==========================================================

  browserWs.on("message", (raw) => {
    let clientMsg;

    try {
      clientMsg = JSON.parse(
        raw.toString()
      );
    } catch (err) {
      console.error(
        "❌ Invalid browser JSON:",
        err.message
      );

      return;
    }

    let forward = null;

    // ======================================================
    // AUDIO
    // ======================================================

    if (clientMsg.type === "audio") {
      // Any actual browser audio means the customer is
      // interacting, so cancel silence follow-up.
      clearSilenceFollowUpTimer();

      // If customer starts answering the follow-up,
      // cancel the 5-second end timer.
      if (waitingForFollowUpAnswer) {
        clearFollowUpEndTimer();

        waitingForFollowUpAnswer = false;
        followUpAlreadySent = false;

        console.log(
          "🎤 Customer started answering follow-up"
        );
      }

      forward = {
        realtimeInput: {
          audio: {
            data: clientMsg.data,
            mimeType: "audio/pcm;rate=16000",
          },
        },
      };
    }

    // ======================================================
    // TEXT
    // ======================================================

    else if (clientMsg.type === "text") {
      clearSilenceFollowUpTimer();

      if (waitingForFollowUpAnswer) {
        clearFollowUpEndTimer();

        waitingForFollowUpAnswer = false;
        followUpAlreadySent = false;
      }

      forward = {
        clientContent: {
          turns: [
            {
              role: "user",
              parts: [
                {
                  text: clientMsg.data || "",
                },
              ],
            },
          ],
          turnComplete: true,
        },
      };
    }

    // ======================================================
    // END AUDIO TURN
    // ======================================================

    else if (
      clientMsg.type === "end_audio_turn"
    ) {
      forward = {
        realtimeInput: {
          audioStreamEnd: true,
        },
      };
    }

    // ======================================================
    // UNKNOWN MESSAGE
    // ======================================================

    else {
      console.log(
        "⚠️ Unknown browser message:",
        clientMsg.type
      );

      return;
    }

    const payload =
      JSON.stringify(forward);

    // ======================================================
    // GEMINI READY
    // ======================================================

    if (
      setupDone &&
      geminiWs.readyState === WebSocket.OPEN
    ) {
      geminiWs.send(payload);
    }

    // ======================================================
    // GEMINI NOT READY
    // ======================================================

    else {
      pendingFromBrowser.push(payload);
    }
  });

  // ==========================================================
  // BROWSER CLOSE
  // ==========================================================

  browserWs.on("close", () => {
    console.log(
      "🔴 Browser WebSocket CLOSED"
    );

    clearAllTimers();

    // ========================================================
    // SAVE CALL TRANSCRIPT
    // ========================================================

    if (transcriptLog.length > 0) {
      try {
        leads.addLead(agentId, {
          name: customerName || "",
          phone: customerPhone || "",
          email: customerEmail || "",
          transcript: transcriptLog,
        });

        console.log(
          "💾 Call transcript saved to leads"
        );
      } catch (err) {
        console.error(
          "❌ Failed to save lead:",
          err.message
        );
      }
    }

    // ========================================================
    // CLOSE GEMINI
    // ========================================================

    if (
      geminiWs.readyState === WebSocket.OPEN ||
      geminiWs.readyState === WebSocket.CONNECTING
    ) {
      geminiWs.close();
    }
  });
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  startBridge,
};