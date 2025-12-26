package com.loggplattform.sdk;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import okhttp3.*;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

public class LoggplattformSDK {
    private final String apiUrl;
    private final String apiKey;
    private final String service;
    private final String environment;
    private String correlationId;
    
    private final BlockingQueue<LogEntry> logQueue;
    private final ScheduledExecutorService scheduler;
    private final ExecutorService executorService;
    private final OkHttpClient httpClient;
    private final Gson gson;
    private final AtomicBoolean shutdown = new AtomicBoolean(false);
    
    private static final int DEFAULT_FLUSH_INTERVAL_SECONDS = 5;
    private static final int DEFAULT_BATCH_SIZE = 10;
    
    public LoggplattformSDK() {
        this(new Builder());
    }
    
    public LoggplattformSDK(Builder builder) {
        this.apiUrl = builder.apiUrl != null ? builder.apiUrl : 
            System.getenv().getOrDefault("LOGGPLATTFORM_API_URL", "http://localhost:3000");
        this.apiKey = builder.apiKey != null ? builder.apiKey : 
            System.getenv().getOrDefault("LOGGPLATTFORM_API_KEY", "");
        this.service = builder.service != null ? builder.service : 
            System.getenv().getOrDefault("LOGGPLATTFORM_SERVICE", "default-service");
        this.environment = builder.environment != null ? builder.environment : 
            System.getenv().getOrDefault("NODE_ENV", "development");
        this.correlationId = builder.correlationId;
        
        if (this.apiKey.isEmpty()) {
            System.err.println("Loggplattform SDK: No API key provided. Logs will not be sent.");
        }
        
        this.logQueue = new LinkedBlockingQueue<>();
        this.scheduler = Executors.newScheduledThreadPool(1);
        this.executorService = Executors.newFixedThreadPool(2);
        this.httpClient = new OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .build();
        this.gson = new Gson();
        
        int flushInterval = builder.flushIntervalSeconds > 0 ? 
            builder.flushIntervalSeconds : DEFAULT_FLUSH_INTERVAL_SECONDS;
        
        // Start periodic flush
        scheduler.scheduleAtFixedRate(this::flush, flushInterval, flushInterval, TimeUnit.SECONDS);
        
        // Shutdown hook
        Runtime.getRuntime().addShutdownHook(new Thread(this::shutdown));
    }
    
    private LogEntry createLogEntry(String level, String message, Map<String, Object> context) {
        Map<String, Object> fullContext = new HashMap<>();
        if (context != null) {
            fullContext.putAll(context);
        }
        fullContext.put("environment", environment);
        fullContext.put("service", service);
        
        return new LogEntry(level, message, fullContext, 
            correlationId != null ? correlationId : 
                (context != null && context.containsKey("correlation_id") ? 
                    String.valueOf(context.get("correlation_id")) : null));
    }
    
    private void queueLog(LogEntry logEntry) {
        try {
            logQueue.offer(logEntry);
            
            // Auto-flush if queue reaches batch size
            if (logQueue.size() >= DEFAULT_BATCH_SIZE) {
                flush();
            }
        } catch (Exception e) {
            // SDK errors should never crash the app
            System.err.println("Loggplattform SDK: Failed to queue log: " + e.getMessage());
        }
    }
    
    public void flush() {
        if (logQueue.isEmpty() || apiKey.isEmpty() || shutdown.get()) {
            return;
        }
        
        List<LogEntry> logsToSend = new ArrayList<>();
        logQueue.drainTo(logsToSend, DEFAULT_BATCH_SIZE);
        
        if (logsToSend.isEmpty()) {
            return;
        }
        
        // Send logs asynchronously
        executorService.submit(() -> {
            for (LogEntry logEntry : logsToSend) {
                sendLog(logEntry);
            }
        });
    }
    
    public void flushSync() {
        if (logQueue.isEmpty() || apiKey.isEmpty()) {
            return;
        }
        
        List<LogEntry> logsToSend = new ArrayList<>();
        logQueue.drainTo(logsToSend);
        
        for (LogEntry logEntry : logsToSend) {
            sendLogSync(logEntry, true); // Force send even during shutdown
        }
    }
    
    private void sendLog(LogEntry logEntry) {
        if (apiKey.isEmpty() || shutdown.get()) {
            return;
        }
        sendLogInternal(logEntry);
    }
    
    private void sendLogSync(LogEntry logEntry) {
        sendLogSync(logEntry, false);
    }
    
    private void sendLogSync(LogEntry logEntry, boolean force) {
        if (apiKey.isEmpty() || (!force && shutdown.get())) {
            return;
        }
        sendLogInternal(logEntry);
    }
    
    private void sendLogInternal(LogEntry logEntry) {
        if (apiKey.isEmpty()) {
            return;
        }
        
        try {
            JsonObject json = new JsonObject();
            json.addProperty("level", logEntry.level);
            json.addProperty("message", logEntry.message);
            json.add("context", gson.toJsonTree(logEntry.context));
            if (logEntry.correlationId != null) {
                json.addProperty("correlation_id", logEntry.correlationId);
            }
            
            RequestBody body = RequestBody.create(
                json.toString(), 
                MediaType.get("application/json; charset=utf-8")
            );
            
            Request request = new Request.Builder()
                .url(apiUrl + "/api/logs")
                .post(body)
                .addHeader("X-API-Key", apiKey)
                .addHeader("Content-Type", "application/json")
                .build();
            
            try (Response response = httpClient.newCall(request).execute()) {
                // Silently handle errors - logs are best-effort
                if (!response.isSuccessful() && System.getenv("LOGGPLATTFORM_DEBUG") != null) {
                    System.err.println("Loggplattform SDK: Failed to send log: " + response.code());
                }
            }
        } catch (Exception e) {
            // SDK errors should never crash the app
            if (System.getenv("LOGGPLATTFORM_DEBUG") != null) {
                System.err.println("Loggplattform SDK: Failed to send log: " + e.getMessage());
            }
        }
    }
    
    public void info(String message) {
        info(message, null);
    }
    
    public void info(String message, Map<String, Object> context) {
        queueLog(createLogEntry("info", message, context));
    }
    
    public void warn(String message) {
        warn(message, null);
    }
    
    public void warn(String message, Map<String, Object> context) {
        queueLog(createLogEntry("warn", message, context));
    }
    
    public void error(String message) {
        error(message, null);
    }
    
    public void error(String message, Map<String, Object> context) {
        queueLog(createLogEntry("error", message, context));
    }
    
    public void debug(String message) {
        debug(message, null);
    }
    
    public void debug(String message, Map<String, Object> context) {
        queueLog(createLogEntry("debug", message, context));
    }
    
    public void setCorrelationId(String correlationId) {
        this.correlationId = correlationId;
    }
    
    public void shutdown() {
        if (shutdown.compareAndSet(false, true)) {
            scheduler.shutdown();
            executorService.shutdown();
            try {
                if (!executorService.awaitTermination(5, TimeUnit.SECONDS)) {
                    executorService.shutdownNow();
                }
            } catch (InterruptedException e) {
                executorService.shutdownNow();
            }
            flushSync();
            httpClient.dispatcher().executorService().shutdown();
        }
    }
    
    private static class LogEntry {
        final String level;
        final String message;
        final Map<String, Object> context;
        final String correlationId;
        
        LogEntry(String level, String message, Map<String, Object> context, String correlationId) {
            this.level = level;
            this.message = message;
            this.context = context;
            this.correlationId = correlationId;
        }
    }
    
    public static class Builder {
        private String apiUrl;
        private String apiKey;
        private String service;
        private String environment;
        private String correlationId;
        private int flushIntervalSeconds = DEFAULT_FLUSH_INTERVAL_SECONDS;
        
        public Builder apiUrl(String apiUrl) {
            this.apiUrl = apiUrl;
            return this;
        }
        
        public Builder apiKey(String apiKey) {
            this.apiKey = apiKey;
            return this;
        }
        
        public Builder service(String service) {
            this.service = service;
            return this;
        }
        
        public Builder environment(String environment) {
            this.environment = environment;
            return this;
        }
        
        public Builder correlationId(String correlationId) {
            this.correlationId = correlationId;
            return this;
        }
        
        public Builder flushIntervalSeconds(int seconds) {
            this.flushIntervalSeconds = seconds;
            return this;
        }
        
        public LoggplattformSDK build() {
            return new LoggplattformSDK(this);
        }
    }
}
