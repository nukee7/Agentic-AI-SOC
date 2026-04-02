Producer
   ↓
Kafka
   ↓
Detection Agent
   ↓
Feature Engineering
   ↓
Stateful Detection
   ↓
Alert Logging

How to add agent:
1) Create new folder

threat-intel-agent/

2) Add consumer.ts

3) Add agent logic

agents/
  threatIntelAgent.ts

4) Add Dockerfile

5) Add service to docker-compose