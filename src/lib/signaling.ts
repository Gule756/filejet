
import { doc, setDoc, onSnapshot, updateDoc, arrayUnion, deleteDoc, serverTimestamp, Firestore } from 'firebase/firestore';

export type SignalMessage = {
  type: 'offer' | 'answer' | 'candidate';
  payload: any;
  from: string;
};

/**
 * Generates a 6-digit random ID.
 */
export const generateId = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Initiates a signaling session by creating a document in Firestore.
 */
export const createSignalingSession = (db: Firestore, sessionId: string, offer: RTCSessionDescriptionInit) => {
  const docRef = doc(db, 'signaling', sessionId);
  return setDoc(docRef, {
    offer: JSON.stringify(offer),
    senderCandidates: [],
    receiverCandidates: [],
    createdAt: serverTimestamp()
  });
};

/**
 * Responds to a signaling session by adding an answer.
 */
export const respondToSignalingSession = (db: Firestore, sessionId: string, answer: RTCSessionDescriptionInit) => {
  const docRef = doc(db, 'signaling', sessionId);
  return updateDoc(docRef, {
    answer: JSON.stringify(answer)
  });
};

/**
 * Adds an ICE candidate to the session.
 */
export const addIceCandidate = (db: Firestore, sessionId: string, candidate: RTCIceCandidate, role: 'sender' | 'receiver') => {
  const docRef = doc(db, 'signaling', sessionId);
  const field = role === 'sender' ? 'senderCandidates' : 'receiverCandidates';
  return updateDoc(docRef, {
    [field]: arrayUnion(JSON.stringify(candidate))
  });
};

/**
 * Cleans up a signaling session.
 */
export const cleanupSignalingSession = (db: Firestore, sessionId: string) => {
  const docRef = doc(doc(db, 'signaling', sessionId).path);
  return deleteDoc(doc(db, 'signaling', sessionId));
};
