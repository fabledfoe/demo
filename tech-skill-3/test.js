/**
 * @file test.js
 * @description This file contains unit tests for the Message Board API using Apollo Server v4.
 * It uses Mocha and Chai for testing, and SQLite for an in-memory database.
 * The tests cover user creation, message posting, and rate limiting functionality.
 */

const { expect } = require('chai');
const { ApolloServer } = require('@apollo/server');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

// Import the server configuration from the main server file
// Ensure your server.js exports these components at the end
const { typeDefs, resolvers } = require('./server.js');

describe('Message Board API Tests', () => {
    let server;
    let db;

    // Before all tests run, set up the Apollo Server and an in-memory database
    before(async () => {
        // Use :memory: to create a temporary, isolated in-memory SQLite database for testing
        db = await open({
            filename: ':memory:',
            driver: sqlite3.Database
        });

        // Execute the same table creation logic as the main server
        await db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, creationDate TEXT NOT NULL)`);
        await db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, userId TEXT NOT NULL, body TEXT NOT NULL, creationDate TEXT NOT NULL, FOREIGN KEY (userId) REFERENCES users (id))`);

        // Create a new ApolloServer instance specifically for testing
        server = new ApolloServer({
            typeDefs,
            resolvers,
        });
    });

    // After all tests have completed, close the database connection
    after(async () => {
        await db.close();
    });

    // Before each individual test, clear the tables to ensure a clean state and prevent tests from interfering with each other
    beforeEach(async () => {
        await db.run('DELETE FROM messages');
        await db.run('DELETE FROM users');
    });

    // Helper function for executing GraphQL operations against the test server
    const executeOperation = async (operation) => {
        // The `executeOperation` method is the standard way to test Apollo Server v4
        return server.executeOperation(operation, {
            // Provide the in-memory database connection to the GraphQL context
            contextValue: { db },
        });
    };

    describe('User Mutations and Queries', () => {
        it('should create a new user successfully', async () => {
            const CREATE_USER = {
                query: `
                    mutation CreateUser($name: String!, $email: String!) {
                        createUser(name: $name, email: $email) {
                            id
                            name
                            email
                        }
                    }
                `,
                variables: { name: "Jane Doe", email: "jane.doe@example.com" },
            };
            const result = await executeOperation(CREATE_USER);
            const user = result.body.singleResult.data.createUser;

            expect(result.body.singleResult.errors).to.be.undefined;
            expect(user.name).to.equal('Jane Doe');
            expect(user.email).to.equal('jane.doe@example.com');
            expect(user.id).to.be.a('string');
        });

        it('should prevent creating a user with a duplicate email', async () => {
            const CREATE_USER_OP = {
                query: `mutation CreateUser($name: String!, $email: String!) { createUser(name: $name, email: $email) { id } }`,
                variables: { name: "Test User", email: "test@example.com" },
            };
            // First creation should succeed
            await executeOperation(CREATE_USER_OP);

            // Second attempt with the same email should fail
            const result = await executeOperation(CREATE_USER_OP);
            expect(result.body.singleResult.errors).to.not.be.undefined;
            expect(result.body.singleResult.errors[0].message).to.equal('A user with this email already exists.');
        });

        it('should list all created users', async () => {
            await executeOperation({ query: `mutation { createUser(name: "User One", email: "one@example.com") { id } }` });
            await executeOperation({ query: `mutation { createUser(name: "User Two", email: "two@example.com") { id } }` });
            
            const LIST_USERS_OP = { query: `query { listUsers { name } }` };
            const result = await executeOperation(LIST_USERS_OP);
            const users = result.body.singleResult.data.listUsers;

            expect(users).to.have.lengthOf(2);
            expect(users[0].name).to.equal('User One');
        });
    });

    describe('Message Mutations and Queries', () => {
        let testUserId;

        beforeEach(async () => {
            const res = await executeOperation({ query: `mutation { createUser(name: "MsgUser", email: "msg@test.com") { id } }` });
            testUserId = res.body.singleResult.data.createUser.id;
        });

        it('should allow a user to post a message', async () => {
            const POST_MESSAGE_OP = {
                query: `
                    mutation PostMessage($userId: ID!, $body: String!) {
                        postMessage(userId: $userId, messageBody: $body) {
                            body
                            user { name }
                        }
                    }
                `,
                variables: { userId: testUserId, body: "First post!" },
            };
            const result = await executeOperation(POST_MESSAGE_OP);
            const message = result.body.singleResult.data.postMessage;

            expect(result.body.singleResult.errors).to.be.undefined;
            expect(message.body).to.equal('First post!');
            expect(message.user.name).to.equal('MsgUser');
        });
        
        it('should correctly link previous and next messages', async () => {
            const POST_MESSAGE_MUTATION = `mutation PostMessage($userId: ID!, $body: String!) { postMessage(userId: $userId, messageBody: $body) { id } }`;
            await executeOperation({ query: POST_MESSAGE_MUTATION, variables: { userId: testUserId, body: "Message 1" } });
            const msg2Result = await executeOperation({ query: POST_MESSAGE_MUTATION, variables: { userId: testUserId, body: "Message 2" } });
            await executeOperation({ query: POST_MESSAGE_MUTATION, variables: { userId: testUserId, body: "Message 3" } });

            const middleMessageId = msg2Result.body.singleResult.data.postMessage.id;

            const GET_MESSAGES_QUERY = {
                query: `
                    query GetMessages($userId: ID!) {
                        listMessagesForUser(userId: $userId) {
                            id
                            body
                            previousPostedMessage { body }
                            nextPostedMessage { body }
                        }
                    }
                `,
                variables: { userId: testUserId },
            };
            const result = await executeOperation(GET_MESSAGES_QUERY);
            const messages = result.body.singleResult.data.listMessagesForUser;
            const middleMessage = messages.find(m => m.id === middleMessageId);

            expect(middleMessage.body).to.equal('Message 2');
            expect(middleMessage.previousPostedMessage.body).to.equal('Message 1');
            expect(middleMessage.nextPostedMessage.body).to.equal('Message 3');
        });
    });

    describe('Rate Limiting Logic', () => {
        it('should prevent a user from posting more than 10 messages per hour', async () => {
            const POST_MESSAGE_OP = {
                query: `mutation PostMessage($userId: ID!) { postMessage(userId: $userId, messageBody: "Spam") { id } }`,
                variables: { userId: "user-to-be-created" }, // Placeholder
            };

            // Create a dedicated user for this test
            const userRes = await executeOperation({ query: `mutation { createUser(name: "RateLimitUser", email: "ratelimit@test.com") { id } }` });
            POST_MESSAGE_OP.variables.userId = userRes.body.singleResult.data.createUser.id;

            // Post 10 messages successfully
            for (let i = 0; i < 10; i++) {
                const result = await executeOperation(POST_MESSAGE_OP);
                expect(result.body.singleResult.errors).to.be.undefined;
            }

            // The 11th message should fail
            const result = await executeOperation(POST_MESSAGE_OP);
            expect(result.body.singleResult.errors).to.not.be.undefined;
            expect(result.body.singleResult.errors[0].message).to.equal('Rate limit exceeded. You can post a maximum of 10 messages per hour.');
        });
    });
});