import http from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const app = express();

app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ==================== TYPES ====================

interface Participant {
  username: string;
  socketId: string;
}

interface Room {
  id: string;
  createdAt: Date;
  participants: Participant[];
}

// ==================== VALIDATION ====================

const JoinRoomSchema = z.object({
  roomId: z.uuidv4().min(1),
  username: z.string().min(1).max(30),
});

type JoinRoomData = z.infer<typeof JoinRoomSchema>;

const rooms = new Map<string, Room>();

function generateRoomId(): string {
  return Math.random().toString(36).substring(2, 11);
}

/**
 * Obtiene todos los participantes de una room
 */
function getRoomParticipants(roomId: string): Participant[] {
  const room = rooms.get(roomId);
  return room ? room.participants : [];
}

/**
 * Elimina un participante de una room
 */
function removeParticipantFromRoom(roomId: string, socketId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.participants = room.participants.filter((p) => p.socketId !== socketId);

  // Si la room queda vacía, la elimina
  if (room.participants.length === 0) {
    rooms.delete(roomId);
    console.log(`Room ${roomId} deleted (no participants)`);
    return;
  }

  // Notifica a todos que alguien se fue
  io.to(roomId).emit("participants-updated", {
    participants: room.participants,
    totalCount: room.participants.length,
  });
}

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on("create-room", (JoinRoomData: JoinRoomData, callback) => {
    try {
      const validated = JoinRoomSchema.parse({
        roomId: uuidv4(),
        username: JoinRoomData.username,
      });
      const roomId = validated.roomId;

      const newRoom: Room = {
        id: roomId,
        createdAt: new Date(),
        participants: [
          {
            username: validated.username,
            socketId: socket.id,
          },
        ],
      };

      rooms.set(roomId, newRoom);
      socket.join(roomId);

      console.log(`Room created: ${roomId} by ${validated.username}`);

      // Responde al cliente con el roomId
      callback({
        success: true,
        roomId: roomId,
        message: `Room created successfully`,
      });

      // Emite participantes actualizados
      io.to(roomId).emit("participants-updated", {
        participants: newRoom.participants,
        totalCount: newRoom.participants.length,
      });
    } catch (error) {
      const errorMessage =
        error instanceof z.ZodError
          ? error.issues.map((issue) => issue.message).join(", ")
          : "Invalid data";

      callback({
        success: false,
        error: errorMessage,
      });
    }
  });

  socket.on("join-room", (joinRoomData: JoinRoomData, callback) => {
    try {
      const validated = JoinRoomSchema.parse(joinRoomData);
      const room = rooms.get(validated.roomId);

      // Valida que la room exista
      if (!room) {
        callback({
          success: false,
          error:
            "Oops! The Room ID you entered doesn't exist or hasn't been created yet.",
        });
        return;
      }

      // Agrega el participante
      const newParticipant: Participant = {
        username: validated.username,
        socketId: socket.id,
      };

      room.participants.push(newParticipant);

      socket.join(validated.roomId);

      console.log(`${validated.username} joined room ${validated.roomId}`);

      // Responde al cliente
      callback({
        success: true,
        message: "Joined room successfully",
        roomId: validated.roomId, // check
      });

      // Notifica a TODOS en la room que hay un nuevo participante
      io.to(validated.roomId).emit("participants-updated", {
        participants: room.participants,
        totalCount: room.participants.length,
        newUser: validated.username,
      });
    } catch (error) {
      const errorMessage =
        error instanceof z.ZodError
          ? error.issues.map((issue) => issue.message).join(", ")
          : "Invalid data";

      callback({
        success: false,
        error: errorMessage,
      });
    }
  });

  socket.on("client-ready", (roomId: string) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("room-not-found", {
        message: "Room does not exist",
      });
      return;
    }

    // Emite la lista actual de participantes al cliente que se conectó
    socket.emit("participants-updated", {
      participants: room.participants,
      totalCount: room.participants.length,
    });

    console.log(`Client ${socket.id} ready in room ${roomId}`);
  });

  socket.on("leave-room", (roomId: string) => {
    socket.leave(roomId);
    removeParticipantFromRoom(roomId, socket.id);
    console.log(`Client ${socket.id} left room ${roomId}`);
  });

  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Encuentra todas las rooms donde estaba este socket y lo elimina
    for (const [roomId, room] of rooms.entries()) {
      const participant = room.participants.find(
        (p) => p.socketId === socket.id,
      );
      if (participant) {
        removeParticipantFromRoom(roomId, socket.id);
      }
    }
  });
});

/**
 * DEBUG: Ver todas las rooms activas
 */
app.get("/rooms", (_req, res) => {
  const roomsData = Array.from(rooms.entries()).map(([id, room]) => ({
    id,
    createdAt: room.createdAt,
    participantsCount: room.participants.length,
    participants: room.participants.map((p) => p.username),
  }));

  res.json({
    totalRooms: roomsData.length,
    rooms: roomsData,
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () =>
  console.log(`Server is running on port ${PORT} now!`),
);
