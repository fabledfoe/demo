/**
 * @file server.js
 * @description This file sets up an Apollo Server with an SQLite database for a message board API.
 * It includes user creation, message posting, and rate limiting functionality.
 * The server uses Apollo Server v4 and Express for handling GraphQL requests.
 * The database schema includes users and messages, with appropriate relationships.
 * It exports the type definitions, resolvers, and database initialization function for testing purposes.
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { ApolloServerPluginDrainHttpServer } = require('@apollo/server/plugin/drainHttpServer');
const { gql } = require('graphql-tag');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// --- Database Setup ---
async function initializeDatabase() {
    const db = await open({
        filename: './message_board.sqlite',
        driver: sqlite3.Database
    });

    await db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            creationDate TEXT NOT NULL
        );
    `);

    await db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            body TEXT NOT NULL,
            creationDate TEXT NOT NULL,
            FOREIGN KEY (userId) REFERENCES users (id)
        );
    `);

    console.log(`${new Date().toISOString()} [DB] Database initialized successfully.`);
    return db;
}

// --- Rate Limiting Store ---
const rateLimitStore = new Map();

// --- GraphQL Schema (Type Definitions) ---
const typeDefs = gql`
    scalar Date

    type User {
        id: ID!
        name: String!
        email: String!
        creationDate: Date!
        numberOfPosts: Int!
    }

    type Message {
        id: ID!
        body: String!
        creationDate: Date!
        user: User!
        previousPostedMessage: Message
        nextPostedMessage: Message
    }

    type Query {
        listUsers: [User!]
        listAllMessages: [Message!]
        listMessagesForUser(userId: ID!): [Message!]
    }

    type Mutation {
        createUser(name: String!, email: String!): User
        postMessage(userId: ID!, messageBody: String!): Message
    }
`;

// --- GraphQL Resolvers ---
const resolvers = {
    // Query and Mutation resolvers
    Query: {
        listUsers: async (parent, args, { db }) => await db.all('SELECT * FROM users'),
        listAllMessages: async (parent, args, { db }) => {
            return await db.all('SELECT * FROM messages ORDER BY creationDate ASC');
        },
        listMessagesForUser: async (parent, { userId }, { db }) => {
            const user = await db.get('SELECT id FROM users WHERE id = ?', userId);
            if (!user) {
                throw new Error('User not found.');
            }
            return await db.all('SELECT * FROM messages WHERE userId = ?', userId);
        },
    },
    Mutation: {
        createUser: async (parent, { name, email }, { db }) => {
            const existingUser = await db.get('SELECT id FROM users WHERE email = ?', email);
            if (existingUser) {
                throw new Error('A user with this email already exists.');
            }

            const newUser = {
                id: uuidv4(),
                name,
                email,
                creationDate: new Date().toISOString(),
            };

            await db.run(
                'INSERT INTO users (id, name, email, creationDate) VALUES (?, ?, ?, ?)',
                newUser.id, newUser.name, newUser.email, newUser.creationDate
            );

            console.log(`${new Date().toISOString()} [LOG] User Created: ${newUser.name} (${newUser.id})`);
            return newUser;
        },
        postMessage: async (parent, { userId, messageBody }, { db }) => {
            const user = await db.get('SELECT id FROM users WHERE id = ?', userId);
            if (!user) {
                throw new Error('User not found. Cannot post message.');
            }

            const now = Date.now();
            const oneHourAgo = now - (60 * 60 * 1000);
            const userTimestamps = rateLimitStore.get(userId) || [];
            const recentTimestamps = userTimestamps.filter(ts => ts > oneHourAgo);

            if (recentTimestamps.length >= 10) {
                console.warn(`${new Date().toISOString()} [LOG] Rate Limit Reached for User: ${userId}`);
                throw new Error('Rate limit exceeded. You can post a maximum of 10 messages per hour.');
            }

            const newMessage = {
                id: uuidv4(),
                userId,
                body: messageBody,
                creationDate: new Date().toISOString(),
            };

            await db.run(
                'INSERT INTO messages (id, userId, body, creationDate) VALUES (?, ?, ?, ?)',
                newMessage.id, newMessage.userId, newMessage.body, newMessage.creationDate
            );

            recentTimestamps.push(now);
            rateLimitStore.set(userId, recentTimestamps);

            console.log(`${new Date().toISOString()} [LOG] Message Posted by User: ${userId}`);
            return newMessage;
        },
    },
    // Field resolvers for User and Message types
    User: {
        numberOfPosts: async (user, args, { db }) => {
            const result = await db.get('SELECT COUNT(*) AS count FROM messages WHERE userId = ?', user.id);
            return result.count;
        },
    },
    Message: {
        user: async (message, args, { db }) => {
            return await db.get('SELECT * FROM users WHERE id = ?', message.userId);
        },
        previousPostedMessage: async (message, args, { db }) => {
            const userMessages = await db.all( 'SELECT * FROM messages WHERE userId = ? ORDER BY creationDate ASC', message.userId );
            const currentIndex = userMessages.findIndex(msg => msg.id === message.id);
            return currentIndex > 0 ? userMessages[currentIndex - 1] : null;
        },
        nextPostedMessage: async (message, args, { db }) => {
            const userMessages = await db.all( 'SELECT * FROM messages WHERE userId = ? ORDER BY creationDate ASC', message.userId );
            const currentIndex = userMessages.findIndex(msg => msg.id === message.id);
            return currentIndex < userMessages.length - 1 ? userMessages[currentIndex + 1] : null;
        },
    },
};

// --- Server Setup (Apollo Server v4) ---
async function startServer() {
    const db = await initializeDatabase();
    const app = express();
    // httpServer handles incoming HTTP requests to our Express app.
    const httpServer = http.createServer(app);

    const server = new ApolloServer({
        typeDefs,
        resolvers,
        plugins: [
            // Proper shutdown for the HTTP server.
            ApolloServerPluginDrainHttpServer({ httpServer }),
        ],
    });

    await server.start();

    // Set up our Express middleware to handle CORS, body parsing,
    // and our expressMiddleware function.
    app.use(
        '/',
        express.json(),
        cors(), // Enable CORS for all routes.
        // expressMiddleware integrates the Apollo Server with the Express app.
        expressMiddleware(server, {
            context: async () => ({ db }), // Pass the database connection to all resolvers.
        }),
    );

    const PORT = process.env.PORT || 4000;
    await new Promise((resolve) => httpServer.listen({ port: PORT }, resolve));
    console.log(`${new Date().toISOString()} Server ready at http://localhost:${PORT}/`);
}

// Exports for testing
module.exports = { typeDefs, resolvers, initializeDatabase, rateLimitStore };


// To run the server directly if this file is executed (as opposed to being imported for testing)
if (require.main === module) {
    startServer();
}