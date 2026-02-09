
"use client"

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Download, HardDrive, ShieldCheck, Zap, X, CheckCircle2, AlertCircle, Share2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { RTC_CONFIG, CHUNK_SIZE, BUFFER_THRESHOLD } from '@/lib/webrtc-config';
import { generateId, createSignalingSession, respondToSignalingSession, addIceCandidate } from '@/lib/signaling';
import { useFirestore } from '@/firebase';
import { doc, onSnapshot } from 'firebase/firestore';

export default function FileJet() {
  const db = useFirestore();
  const [myId, setMyId] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [transferMode, setTransferMode] = useState<'idle' | 'sending' | 'receiving'>('idle');
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [receivedFile, setReceivedFile] = useState<Blob | null>(null);
  
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const dataChannel = useRef<RTCDataChannel | null>(null);
  const { toast } = useToast();

  // Initialize My ID and listen for incoming connections
  useEffect(() => {
    const id = generateId();
    setMyId(id);

    if (!db) return;

    // Listen to our own ID for incoming offers
    const myDocRef = doc(db, 'signaling', id);
    const unsubscribe = onSnapshot(myDocRef, async (snapshot) => {
      const data = snapshot.data();
      if (!data) return;

      // Case: Someone sent us an offer
      if (data.offer && !peerConnection.current) {
        setConnectionStatus('connecting');
        const pc = setupPeerConnection(id, 'receiver');
        
        // Listen for data channel
        pc.ondatachannel = (event) => {
          dataChannel.current = event.channel;
          setupDataChannelEvents(event.channel);
        };

        const offer = JSON.parse(data.offer);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        respondToSignalingSession(db, id, answer);
      }

      // Case: Handle incoming ICE candidates for the receiver role
      if (data.senderCandidates && peerConnection.current) {
        data.senderCandidates.forEach(async (candStr: string) => {
          try {
            const candidate = new RTCIceCandidate(JSON.parse(candStr));
            await peerConnection.current?.addIceCandidate(candidate);
          } catch (e) {}
        });
      }
    });

    return () => unsubscribe();
  }, [db]);

  const cleanup = useCallback(() => {
    if (dataChannel.current) {
      dataChannel.current.close();
      dataChannel.current = null;
    }
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    setConnectionStatus('disconnected');
    setTransferMode('idle');
    setProgress(0);
    setReceivedFile(null);
  }, []);

  const setupPeerConnection = useCallback((sessionId: string, role: 'sender' | 'receiver') => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    
    pc.onicecandidate = (event) => {
      if (event.candidate && db) {
        addIceCandidate(db, sessionId, event.candidate, role === 'sender' ? 'sender' : 'receiver');
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        setConnectionStatus('connected');
        toast({ title: "Connected", description: "P2P connection established!" });
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        cleanup();
        toast({ variant: "destructive", title: "Disconnected", description: "Connection lost." });
      }
    };

    peerConnection.current = pc;
    return pc;
  }, [db, cleanup, toast]);

  const setupDataChannelEvents = useCallback((dc: RTCDataChannel) => {
    let receivedChunks: Uint8Array[] = [];
    let bytesReceived = 0;
    let expectedSize = 0;

    dc.onopen = () => {
      setConnectionStatus('connected');
    };

    dc.onclose = () => {
      cleanup();
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'metadata') {
            setFileName(msg.name);
            setFileSize(msg.size);
            expectedSize = msg.size;
            setTransferMode('receiving');
            receivedChunks = [];
            bytesReceived = 0;
            setProgress(0);
          } else if (msg.type === 'eof') {
            const blob = new Blob(receivedChunks);
            setReceivedFile(blob);
            setProgress(100);
            toast({ title: "Received", description: "File transfer complete!" });
          }
        } catch (e) {
          console.error("Message error:", e);
        }
      } else {
        receivedChunks.push(new Uint8Array(event.data));
        bytesReceived += event.data.byteLength;
        setProgress((bytesReceived / expectedSize) * 100);
      }
    };
  }, [cleanup, toast]);

  const handleSendFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const dc = dataChannel.current;
    if (!dc || dc.readyState !== 'open') {
      toast({ 
        variant: "destructive",
        title: "Connection Required", 
        description: "Please wait for the connection to be fully established." 
      });
      return;
    }

    setFileName(file.name);
    setFileSize(file.size);
    setTransferMode('sending');
    setProgress(0);

    try {
      dc.send(JSON.stringify({ type: 'metadata', name: file.name, size: file.size }));

      const reader = file.stream().getReader();
      let offset = 0;

      const sendNextChunk = async () => {
        while (true) {
          if (!dataChannel.current || dataChannel.current.readyState !== 'open') break;

          if (dc.bufferedAmount > BUFFER_THRESHOLD) {
            dc.onbufferedamountlow = () => {
              dc.onbufferedamountlow = null;
              sendNextChunk();
            };
            return;
          }

          const { done, value } = await reader.read();
          if (done) {
            if (dataChannel.current.readyState === 'open') {
              dc.send(JSON.stringify({ type: 'eof' }));
            }
            toast({ title: "Success", description: "File sent successfully!" });
            return;
          }

          dc.send(value);
          offset += value.byteLength;
          setProgress((offset / file.size) * 100);
        }
      };

      sendNextChunk();
    } catch (err) {
      toast({ variant: "destructive", title: "Transfer Failed", description: "An error occurred." });
      setTransferMode('idle');
    }
  };

  const handleConnect = async () => {
    if (!recipientId || recipientId.length !== 6 || !db) {
      toast({ title: "Invalid ID", description: "Please enter a valid 6-digit ID." });
      return;
    }

    setConnectionStatus('connecting');
    const pc = setupPeerConnection(recipientId, 'sender');
    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    dataChannel.current = dc;
    setupDataChannelEvents(dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      await createSignalingSession(db, recipientId, offer);

      // Listen for the answer on the recipient's doc
      const recipientDocRef = doc(db, 'signaling', recipientId);
      const unsubscribe = onSnapshot(recipientDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (!data) return;

        if (data.answer && pc.signalingState !== 'stable') {
          const answer = JSON.parse(data.answer);
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }

        if (data.receiverCandidates) {
          data.receiverCandidates.forEach(async (candStr: string) => {
            try {
              const candidate = new RTCIceCandidate(JSON.parse(candStr));
              await pc.addIceCandidate(candidate);
            } catch (e) {}
          });
        }
      });

      // Cleanup listener when connection is stable/closed
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setConnectionStatus('connected');
          unsubscribe();
        }
      };

    } catch (err) {
      setConnectionStatus('disconnected');
      toast({ variant: "destructive", title: "Connection Error", description: "Failed to initiate signaling." });
    }
  };

  const downloadFile = () => {
    if (!receivedFile) return;
    const url = URL.createObjectURL(receivedFile);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyId = () => {
    navigator.clipboard.writeText(myId);
    toast({ title: "Copied", description: "ID copied to clipboard" });
  };

  return (
    <div className="min-h-screen bg-background bg-gradient-tech p-4 md:p-8 flex flex-col items-center justify-center">
      <div className="w-full max-w-5xl space-y-8">
        <header className="flex flex-col md:flex-row items-center justify-between gap-4 text-center md:text-left">
          <div className="flex items-center gap-3">
            <div className="bg-primary p-3 rounded-xl shadow-lg shadow-primary/20">
              <Zap className="w-8 h-8 text-white fill-current" />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight font-headline">FileJet</h1>
              <p className="text-muted-foreground text-sm">Lightning-fast P2P file transfer</p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="bg-card border px-4 py-2 rounded-lg flex items-center gap-3">
              <span className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Your ID</span>
              <code className="text-xl font-bold text-primary tracking-widest">{myId || '------'}</code>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={copyId}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Badge variant={connectionStatus === 'connected' ? 'default' : connectionStatus === 'connecting' ? 'secondary' : 'outline'} className="h-8 px-3">
              <div className={`w-2 h-2 rounded-full mr-2 ${connectionStatus === 'connected' ? 'bg-green-500 animate-pulse' : 'bg-orange-500'}`} />
              {connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}
            </Badge>
          </div>
        </header>

        <div className="grid md:grid-cols-2 gap-8">
          <Card className="border-2 border-primary/20 overflow-hidden bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="w-5 h-5 text-primary" />
                Sender Panel
              </CardTitle>
              <CardDescription>Initiate a secure transfer to another device</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Recipient Connection</label>
                  <div className="flex gap-2">
                    <Input 
                      placeholder="Enter 6-digit Recipient ID" 
                      className="text-center tracking-widest text-lg font-bold h-12"
                      value={recipientId}
                      onChange={(e) => setRecipientId(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      disabled={connectionStatus === 'connected'}
                    />
                    <Button 
                      className="h-12 px-6" 
                      onClick={handleConnect}
                      disabled={connectionStatus !== 'disconnected' || recipientId.length !== 6}
                    >
                      Connect
                    </Button>
                  </div>
                </div>

                <Separator className="my-6" />

                <div className="space-y-4">
                  <label className="text-xs font-semibold uppercase text-muted-foreground">Upload File</label>
                  <div className="file-drop-zone p-8 flex flex-col items-center justify-center text-center gap-4 relative">
                    <input 
                      type="file" 
                      className="absolute inset-0 opacity-0 cursor-pointer disabled:cursor-not-allowed"
                      onChange={handleSendFile}
                      disabled={connectionStatus !== 'connected' || transferMode !== 'idle'}
                    />
                    <div className="p-4 rounded-full bg-primary/10">
                      <HardDrive className={`w-10 h-10 ${connectionStatus === 'connected' ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <p className="font-semibold">{connectionStatus === 'connected' ? 'Drop file or click to browse' : 'Connect to send files'}</p>
                      <p className="text-sm text-muted-foreground">No file size limit (RAM-to-RAM)</p>
                    </div>
                  </div>
                </div>

                {transferMode === 'sending' && (
                  <div className="bg-secondary/30 p-4 rounded-lg space-y-3">
                    <div className="flex justify-between items-center text-sm">
                      <span className="font-medium truncate max-w-[200px]">{fileName}</span>
                      <span className="text-primary font-bold">{Math.round(progress)}%</span>
                    </div>
                    <Progress value={progress} className="h-2" />
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="border-2 border-accent/20 overflow-hidden bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Download className="w-5 h-5 text-accent" />
                Receiver Panel
              </CardTitle>
              <CardDescription>Monitor and download incoming files</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-col items-center justify-center min-h-[300px] gap-6 text-center">
                {transferMode === 'receiving' ? (
                  <div className="w-full space-y-8 animate-in fade-in slide-in-from-bottom-4">
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-20 h-20 rounded-2xl bg-accent/10 flex items-center justify-center relative">
                        <Download className="w-10 h-10 text-accent animate-bounce" />
                        <div className="absolute inset-0 rounded-2xl border-2 border-accent animate-ping opacity-20" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold">{fileName}</h3>
                        <p className="text-muted-foreground text-sm">{(fileSize / (1024 * 1024)).toFixed(2)} MB</p>
                      </div>
                    </div>

                    <div className="space-y-3 w-full max-w-md mx-auto">
                      <div className="flex justify-between text-xs font-bold uppercase tracking-widest text-accent">
                        <span>Transferring...</span>
                        <span>{Math.round(progress)}%</span>
                      </div>
                      <div className="relative h-4 w-full bg-secondary rounded-full overflow-hidden">
                        <div 
                          className="absolute h-full bg-accent transition-all duration-300 ease-out"
                          style={{ width: `${progress}%` }}
                        />
                        <div className="absolute inset-0 progress-shimmer opacity-30" />
                      </div>
                    </div>

                    {progress === 100 && (
                      <Button className="w-full h-14 text-lg bg-accent hover:bg-accent/90 shadow-lg shadow-accent/20 gap-3" onClick={downloadFile}>
                        <CheckCircle2 className="w-6 h-6" />
                        Download File
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-4 opacity-50">
                    <div className="p-8 rounded-full border-4 border-dashed border-muted-foreground/20">
                      <Share2 className="w-16 h-16 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-lg font-semibold">Waiting for Incoming Files</p>
                      <p className="text-sm">Share your ID with the sender to begin</p>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <footer className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-card border">
            <ShieldCheck className="w-6 h-6 text-green-500" />
            <div className="text-sm">
              <p className="font-bold">Zero-Knowledge</p>
              <p className="text-muted-foreground">Files never touch our servers.</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-card border">
            <Zap className="w-6 h-6 text-primary" />
            <div className="text-sm">
              <p className="font-bold">Peer-to-Peer</p>
              <p className="text-muted-foreground">Direct browser-to-browser speed.</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-xl bg-card border">
            <AlertCircle className="w-6 h-6 text-accent" />
            <div className="text-sm">
              <p className="font-bold">Encrypted</p>
              <p className="text-muted-foreground">Secure end-to-end data channels.</p>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
