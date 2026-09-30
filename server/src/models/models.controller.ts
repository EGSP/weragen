import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type {
    AcceptedResponse,
    CreateModelProfileRequest,
    ModelListResponse,
    ModelProfile,
    UpdateModelProfileRequest,
} from '@weragen/types';
import { createModelProfileRequestSchema, updateModelProfileRequestSchema } from '@weragen/types';
import { ModelsService } from './models.service.js';

@Controller('api/models')
export class ModelsController {
    constructor(private readonly models: ModelsService) {}

    /** Справочник вместе с сессиями, в которых сейчас идёт ход на каждой из моделей. */
    @Get()
    async list(): Promise<ModelListResponse> {
        return { models: await this.models.list() };
    }

    @Post()
    async create(@Body() body: CreateModelProfileRequest): Promise<ModelProfile> {
        return this.models.create(createModelProfileRequestSchema.parse(body));
    }

    /** Правка признаков и пометки по умолчанию. Идентификатор модели не меняется. */
    @Patch(':id')
    async update(
        @Param('id') id: string,
        @Body() body: UpdateModelProfileRequest,
    ): Promise<ModelProfile> {
        return this.models.update(id, updateModelProfileRequestSchema.parse(body));
    }

    /**
     * Удаление записи. Пока моделью исполняется ход, запрос отклоняется с кодом 409, и тело
     * отказа перечисляет эти сессии в поле `sessions`.
     */
    @Delete(':id')
    async remove(@Param('id') id: string): Promise<AcceptedResponse> {
        await this.models.remove(id);
        return { accepted: true };
    }
}
