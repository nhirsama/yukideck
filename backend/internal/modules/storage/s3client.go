package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

type S3Object struct {
	Key          string
	Size         int64
	LastModified time.Time
	ContentType  string
	Metadata     map[string]string
}

type S3ListResult struct {
	Objects        []S3Object
	CommonPrefixes []string
	Truncated      bool
	NextCursor     string
}

type PresignedPut struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
}

// Bucket abstracts the minimal S3 operations needed by the storage manager (easy to test in-memory).
type Bucket interface {
	TestConnection(ctx context.Context) error
	List(ctx context.Context, prefix, delimiter, cursor string, limit int32) (*S3ListResult, error)
	Head(ctx context.Context, key string) (*S3Object, error)
	Put(ctx context.Context, key string, data []byte, contentType string, metadata map[string]string) error
	Copy(ctx context.Context, srcKey, dstKey string, contentType string) error
	Delete(ctx context.Context, keys []string) error
	PresignPut(ctx context.Context, key, contentType string, metadata map[string]string, expires time.Duration) (*PresignedPut, error)
}

type BucketFactory func(cfg PlainConfig) (Bucket, error)

type awsS3Bucket struct {
	client  *s3.Client
	presign *s3.PresignClient
	bucket  string
}

func NewAWSS3Bucket(cfg PlainConfig, timeout time.Duration) (Bucket, error) {
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	region := strings.TrimSpace(cfg.Region)
	if region == "" {
		region = "auto"
	}
	endpoint := strings.TrimSpace(cfg.Endpoint)

	awsCfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(cfg.AccessKey, cfg.SecretKey, ""),
		HTTPClient:  &http.Client{Timeout: timeout},
	}

	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
		o.UsePathStyle = cfg.ForcePathStyle
	})
	return &awsS3Bucket{
		client:  client,
		presign: s3.NewPresignClient(client),
		bucket:  cfg.Bucket,
	}, nil
}

func (b *awsS3Bucket) TestConnection(ctx context.Context) error {
	_, err := b.client.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: aws.String(b.bucket),
	})
	if err != nil {
		return fmt.Errorf("无法访问存储桶 %q: %w", b.bucket, err)
	}
	return nil
}

func (b *awsS3Bucket) List(ctx context.Context, prefix, delimiter, cursor string, limit int32) (*S3ListResult, error) {
	in := &s3.ListObjectsV2Input{
		Bucket: aws.String(b.bucket),
	}
	if prefix != "" {
		in.Prefix = aws.String(prefix)
	}
	if delimiter != "" {
		in.Delimiter = aws.String(delimiter)
	}
	if cursor != "" {
		in.ContinuationToken = aws.String(cursor)
	}
	if limit > 0 {
		in.MaxKeys = aws.Int32(limit)
	}

	out, err := b.client.ListObjectsV2(ctx, in)
	if err != nil {
		return nil, err
	}

	res := &S3ListResult{
		Objects:        make([]S3Object, 0, len(out.Contents)),
		CommonPrefixes: make([]string, 0, len(out.CommonPrefixes)),
		Truncated:      aws.ToBool(out.IsTruncated),
		NextCursor:     aws.ToString(out.NextContinuationToken),
	}
	for _, cp := range out.CommonPrefixes {
		if p := aws.ToString(cp.Prefix); p != "" {
			res.CommonPrefixes = append(res.CommonPrefixes, p)
		}
	}
	for _, obj := range out.Contents {
		res.Objects = append(res.Objects, S3Object{
			Key:          aws.ToString(obj.Key),
			Size:         aws.ToInt64(obj.Size),
			LastModified: aws.ToTime(obj.LastModified),
		})
	}
	return res, nil
}

func (b *awsS3Bucket) Head(ctx context.Context, key string) (*S3Object, error) {
	out, err := b.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(b.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && (apiErr.ErrorCode() == "NotFound" || apiErr.ErrorCode() == "NoSuchKey" || apiErr.ErrorCode() == "404") {
			return nil, nil
		}
		var notFound *types.NotFound
		if errors.As(err, &notFound) {
			return nil, nil
		}
		return nil, err
	}
	return &S3Object{
		Key:          key,
		Size:         aws.ToInt64(out.ContentLength),
		LastModified: aws.ToTime(out.LastModified),
		ContentType:  aws.ToString(out.ContentType),
		Metadata:     out.Metadata,
	}, nil
}

func (b *awsS3Bucket) Put(ctx context.Context, key string, data []byte, contentType string, metadata map[string]string) error {
	in := &s3.PutObjectInput{
		Bucket:      aws.String(b.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	}
	if len(metadata) > 0 {
		in.Metadata = metadata
	}
	_, err := b.client.PutObject(ctx, in)
	return err
}

func (b *awsS3Bucket) Copy(ctx context.Context, srcKey, dstKey string, contentType string) error {
	// S3 CopySource must URL-encode path segments while preserving '/'
	segs := strings.Split(srcKey, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	copySource := b.bucket + "/" + strings.Join(segs, "/")

	in := &s3.CopyObjectInput{
		Bucket:     aws.String(b.bucket),
		CopySource: aws.String(copySource),
		Key:        aws.String(dstKey),
	}
	if contentType != "" {
		in.ContentType = aws.String(contentType)
		in.MetadataDirective = types.MetadataDirectiveReplace
	}
	_, err := b.client.CopyObject(ctx, in)
	return err
}

func (b *awsS3Bucket) Delete(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	if len(keys) == 1 {
		_, err := b.client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(b.bucket),
			Key:    aws.String(keys[0]),
		})
		return err
	}
	const batchSize = 500
	for i := 0; i < len(keys); i += batchSize {
		end := i + batchSize
		if end > len(keys) {
			end = len(keys)
		}
		objs := make([]types.ObjectIdentifier, 0, end-i)
		for _, k := range keys[i:end] {
			objs = append(objs, types.ObjectIdentifier{Key: aws.String(k)})
		}
		_, err := b.client.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: aws.String(b.bucket),
			Delete: &types.Delete{Objects: objs, Quiet: aws.Bool(true)},
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (b *awsS3Bucket) PresignPut(ctx context.Context, key, contentType string, metadata map[string]string, expires time.Duration) (*PresignedPut, error) {
	in := &s3.PutObjectInput{
		Bucket:      aws.String(b.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}
	if len(metadata) > 0 {
		in.Metadata = metadata
	}
	req, err := b.presign.PresignPutObject(ctx, in, func(o *s3.PresignOptions) {
		o.Expires = expires
	})
	if err != nil {
		return nil, err
	}
	headers := make(map[string]string)
	for k, vals := range req.SignedHeader {
		if strings.EqualFold(k, "Host") {
			continue
		}
		if len(vals) > 0 {
			headers[k] = vals[0]
		}
	}
	if _, ok := headers["Content-Type"]; !ok && contentType != "" {
		headers["Content-Type"] = contentType
	}
	return &PresignedPut{
		URL:     req.URL,
		Method:  req.Method,
		Headers: headers,
	}, nil
}
