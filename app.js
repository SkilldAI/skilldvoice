require('dotenv').config();
require('colors');

const express = require('express');
const ExpressWs = require('express-ws');
const twilio = require('twilio');

const { GptService } = require('./services/gpt-service');
const { StreamService } = require('./services/stream-service');
const { TranscriptionService } = require('./services/transcription-service');
const { TextToSpeechService } = require('./services/tts-service');
const { recordingService } = require('./services/recording-service');

const VoiceResponse = require('twilio').twiml.VoiceResponse;

const app = express();
ExpressWs(app);

app.use(express.json());
app.use(express.static('public'));

// Add explicit route for root
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: './public' });
});

const PORT = process.env.PORT || 3000;

// Default prompts that can be overridden through the web interface
let currentSystemPrompt = `You are an outbound education consultant helping students find the right university and course for studying abroad. You have a warm and professional personality. Keep your responses engaging yet concise but make every attempt to keep the prospective student interested without being overly pushy. You must not ask more than one question at a time. Do not make assumptions about what values to plug into functions. Ask for clarification if a user request is ambiguous. Guide the student through the decision-making process by asking questions like, "What are your current academic interests and career aspirations?" or "Do you have a preferred study destination in mind?" If they are unsure about their choices, help them explore options by discussing program strengths, university rankings, and scholarship opportunities. Once they show interest in a specific course or university, ask if they would like to schedule a call to discuss the next steps. You must add a '•' symbol every 5 to 10 words at natural pauses where your response can be split for text-to-speech.`;

let currentInitialMessage = `Hello Ashutosh, this is Priya from GlobalEd Consulting, I wanted to quickly check in about your interest in studying abroad and see how we can help you find the right university and program!`;

// Initialize Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Make outbound call endpoint
app.post('/make-call', async (req, res) => {
  try {
    const { phoneNumber, systemPrompt, initialMessage } = req.body;
    
    if (!phoneNumber || !systemPrompt || !initialMessage) {
      return res.status(400).json({ 
        success: false, 
        error: 'Phone number, system prompt, and initial message are required' 
      });
    }

    // Update current prompts
    currentSystemPrompt = systemPrompt;
    currentInitialMessage = initialMessage;

    const call = await twilioClient.calls.create({
      url: `https://${process.env.SERVER}/incoming`,
      to: phoneNumber,
      from: process.env.FROM_NUMBER
    });

    res.json({ 
      success: true, 
      callSid: call.sid 
    });
  } catch (error) {
    console.error('Error making call:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to initiate call' 
    });
  }
});

app.post('/incoming', (req, res) => {
  try {
    const response = new VoiceResponse();
    const connect = response.connect();
    connect.stream({ url: `wss://${process.env.SERVER}/connection` });
  
    res.type('text/xml');
    res.end(response.toString());
  } catch (err) {
    console.log(err);
  }
});

app.ws('/connection', (ws) => {
  try {
    ws.on('error', console.error);
    // Filled in from start message
    let streamSid;
    let callSid;

    const gptService = new GptService(currentSystemPrompt, currentInitialMessage);
    const streamService = new StreamService(ws);
    const transcriptionService = new TranscriptionService();
    const ttsService = new TextToSpeechService({});
  
    let marks = [];
    let interactionCount = 0;
  
    // Incoming from MediaStream
    ws.on('message', function message(data) {
      const msg = JSON.parse(data);
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        
        streamService.setStreamSid(streamSid);
        gptService.setCallSid(callSid);

        // Set RECORDING_ENABLED='true' in .env to record calls
        recordingService(ttsService, callSid).then(() => {
          console.log(`Twilio -> Starting Media Stream for ${streamSid}`.underline.red);
          ttsService.generate({partialResponseIndex: null, partialResponse: currentInitialMessage}, 0);
        });
      } else if (msg.event === 'media') {
        transcriptionService.send(msg.media.payload);
      } else if (msg.event === 'mark') {
        const label = msg.mark.name;
        console.log(`Twilio -> Audio completed mark (${msg.sequenceNumber}): ${label}`.red);
        marks = marks.filter(m => m !== msg.mark.name);
      } else if (msg.event === 'stop') {
        console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
      }
    });
  
    transcriptionService.on('utterance', async (text) => {
      // This is a bit of a hack to filter out empty utterances
      if(marks.length > 0 && text?.length > 5) {
        console.log('Twilio -> Interruption, Clearing stream'.red);
        ws.send(
          JSON.stringify({
            streamSid,
            event: 'clear',
          })
        );
      }
    });
  
    transcriptionService.on('transcription', async (text) => {
      if (!text) { return; }
      console.log(`Interaction ${interactionCount} – STT -> GPT: ${text}`.yellow);
      gptService.completion(text, interactionCount);
      interactionCount += 1;
    });
    
    gptService.on('gptreply', async (gptReply, icount) => {
      console.log(`Interaction ${icount}: GPT -> TTS: ${gptReply.partialResponse}`.green );
      ttsService.generate(gptReply, icount);
    });
  
    ttsService.on('speech', (responseIndex, audio, label, icount) => {
      console.log(`Interaction ${icount}: TTS -> TWILIO: ${label}`.blue);
  
      streamService.buffer(responseIndex, audio);
    });
  
    streamService.on('audiosent', (markLabel) => {
      marks.push(markLabel);
    });
  } catch (err) {
    console.log(err);
  }
});

app.listen(PORT);
console.log(`Server running on port ${PORT}`);
